import JSZip from 'jszip';
import {
  db,
  deleteJmdictInBatches,
  type ImportRecord,
  type InstalledLanguagePackRecord,
  type JmdictEntryItem,
} from '../db/db';
import { ensureDefaultDeck } from '../db/cards';
import { getAllLanguagePacks, getLanguagePack } from '../packs/registry';
import { STARTER_LEXICONS, type StarterLexiconEntry } from '../packs/starterData';
import { JAPANESE_DICTIONARY_SAMPLE } from '../packs/japanese/dictionaryData';
import { deriveFrequencyInfo } from '../packs/japanese/jmdictFrequency';
import { buildMandarinPinyinSegments } from '../packs/multilingualPack';
import { logEvent } from './eventLogger';

export const DEFAULT_PACK_MANIFEST_URL =
  'https://cdn.jsdelivr.net/gh/linguaforge/packs@main/manifest.json';
export const PACK_MANIFEST_URL_KEY = 'packManifestUrl';
const INSTALLED_PACKS_SEEDED_KEY = 'installedPacksSeededV1';

export interface CloudPackManifestItem {
  version: string;
  bundleUrl: string;
  sizeBytes?: number;
  entryCount?: number;
  checksum?: string;
}

export interface CloudPackManifest {
  manifestVersion?: string;
  updatedAt?: string;
  packs: Record<string, CloudPackManifestItem>;
}

export interface PackInstallProgress {
  percent: number;
  stage: string;
  loadedBytes?: number;
  totalBytes?: number;
}

export interface PackInstallResult {
  record: InstalledLanguagePackRecord;
  source: 'starter' | 'cloud' | 'bundled';
  entryCount: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Download cancelled', 'AbortError');
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError')
  );
}

export async function getPackManifestUrl(): Promise<string> {
  try {
    const row = await db.settings.get(PACK_MANIFEST_URL_KEY);
    if (row && typeof row.value === 'string' && row.value.trim()) {
      return row.value.trim();
    }
  } catch {
    // Ignore DB errors
  }
  return DEFAULT_PACK_MANIFEST_URL;
}

export async function setPackManifestUrl(url: string): Promise<string> {
  const clean = url.trim() || DEFAULT_PACK_MANIFEST_URL;
  await db.settings.put({ key: PACK_MANIFEST_URL_KEY, value: clean });
  return clean;
}

export async function ensureInitialInstalledPacks(): Promise<void> {
  try {
    const existing = await db.installedPacks.toArray();
    if (existing.length > 0) return;

    const seededFlag = await db.settings.get(INSTALLED_PACKS_SEEDED_KEY);
    if (seededFlag?.value === true) return;

    const now = Date.now();
    const jaCount = await db.jmdictEntries.where('languageCode').equals('ja').count().catch(() => 0);
    await db.installedPacks.put({
      languageId: 'ja',
      version: '1.0.4',
      installedAt: now,
      updatedAt: now,
      source: jaCount > 0 ? 'cloud' : 'bundled',
      entryCount: jaCount,
      sizeBytes: jaCount > 0 ? 15728640 : 0,
      subpacks: jaCount > 0 ? ['jmdict-core'] : ['bundled-starter'],
    });
    await db.settings.put({ key: INSTALLED_PACKS_SEEDED_KEY, value: true });
  } catch {
    // Ignore DB errors in non-browser test runners
  }
}

export async function getInstalledPacksMap(): Promise<Record<string, InstalledLanguagePackRecord>> {
  await ensureInitialInstalledPacks();
  try {
    const rows = await db.installedPacks.toArray();
    const map: Record<string, InstalledLanguagePackRecord> = {};
    for (const r of rows) {
      map[r.languageId] = r;
    }
    return map;
  } catch {
    return {};
  }
}

export async function getInstalledLanguageIds(): Promise<string[]> {
  const map = await getInstalledPacksMap();
  const registryIds = getAllLanguagePacks().map((p) => p.id);
  const installed = registryIds.filter((id) => Boolean(map[id]));
  if (installed.length === 0) {
    return ['ja'];
  }
  return installed;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function checkPackUpdateAvailable(
  installed: InstalledLanguagePackRecord | undefined,
  manifestVersion?: string
): boolean {
  if (!installed) return false;
  const target = manifestVersion || installed.latestManifestVersion;
  if (!target) return false;
  return compareVersions(target, installed.version) > 0;
}

export async function fetchCloudPackManifest(
  url?: string,
  signal?: AbortSignal
): Promise<CloudPackManifest | null> {
  if (typeof fetch === 'undefined') return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;

  const targetUrl = (url || (await getPackManifestUrl())).trim();
  if (!targetUrl) return null;

  try {
    const res = await fetch(targetUrl, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data === 'object' && data.packs && typeof data.packs === 'object') {
      return data as CloudPackManifest;
    }
    return null;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

interface RawPackEntryInput {
  id?: string;
  word: string;
  readings?: string[];
  meanings: string[];
  partsOfSpeech?: string[];
  level?: string;
  frequencyRank?: number;
  aliases?: string[];
}

function normalizeEntriesToJmdictItems(
  languageId: string,
  importId: string,
  entries: RawPackEntryInput[],
  kind: 'dictionary' | 'frequency' = 'dictionary'
): JmdictEntryItem[] {
  const out: JmdictEntryItem[] = [];
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i];
    const word = String(raw.word || '').trim();
    if (!word) continue;

    const readings = Array.isArray(raw.readings)
      ? raw.readings.map((r) => String(r).trim()).filter(Boolean)
      : [];
    if (languageId === 'zh' && readings.length === 0) {
      const py = buildMandarinPinyinSegments(word).reading;
      if (py) readings.push(py);
    }

    const meanings = Array.isArray(raw.meanings)
      ? raw.meanings.map((m) => String(m).trim()).filter(Boolean)
      : [];
    const pos = Array.isArray(raw.partsOfSpeech) && raw.partsOfSpeech.length > 0
      ? raw.partsOfSpeech
      : ['Word'];

    const formsSet = new Set<string>([word, word.toLowerCase()]);
    for (const r of readings) {
      formsSet.add(r);
      formsSet.add(r.toLowerCase());
    }
    for (const a of raw.aliases || []) {
      const clean = String(a).trim();
      if (clean) {
        formsSet.add(clean);
        formsSet.add(clean.toLowerCase());
      }
    }

    const freqRank =
      typeof raw.frequencyRank === 'number' && Number.isFinite(raw.frequencyRank)
        ? raw.frequencyRank
        : undefined;
    const freqInfo = deriveFrequencyInfo([], freqRank);
    const priorityScore = freqRank ? Math.max(10, 10000 - Math.min(9990, freqRank)) : 100;

    out.push({
      id: raw.id ? `${languageId}-${raw.id}` : `${importId}-${i}-${word}`,
      languageCode: languageId,
      forms: Array.from(formsSet),
      kanji: [{ text: word, common: freqRank !== undefined ? freqRank <= 2500 : true }],
      kana: readings.map((r) => ({ text: r })),
      senses: [
        {
          partsOfSpeech: pos,
          glosses: meanings.length > 0 ? meanings : [`Vocabulary entry (${word})`],
        },
      ],
      primaryWord: word,
      primaryReading: readings[0] || '',
      priorityScore,
      priorityTags: [],
      frequencyBand: freqInfo.frequencyBand,
      frequencyRank: freqRank,
      jlptLevel: raw.level || undefined,
      importIds: [importId],
      kinds: [kind],
    });
  }
  return out;
}

async function streamAndParseCloudBundle(
  bundleUrl: string,
  signal?: AbortSignal,
  onProgress?: (p: PackInstallProgress) => void
): Promise<RawPackEntryInput[]> {
  const res = await fetch(bundleUrl, { signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while downloading pack bundle`);
  }

  const totalHeader = Number(res.headers.get('content-length') || 0);
  let bytes: Uint8Array;

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        const pct = totalHeader > 0 ? Math.min(80, Math.round((loaded / totalHeader) * 80)) : 35;
        onProgress?.({
          percent: pct,
          stage: 'Downloading language pack...',
          loadedBytes: loaded,
          totalBytes: totalHeader || undefined,
        });
      }
    }

    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    const buf = await res.arrayBuffer();
    bytes = new Uint8Array(buf);
    onProgress?.({ percent: 80, stage: 'Downloaded pack bundle' });
  }

  throwIfAborted(signal);

  let jsonText = '';
  const lowerUrl = bundleUrl.toLowerCase();

  if (lowerUrl.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(bytes);
    const jsonName = Object.keys(zip.files).find((n) => n.endsWith('.json') && !zip.files[n].dir);
    if (!jsonName) {
      throw new Error('Pack archive does not contain a JSON dictionary file.');
    }
    jsonText = await zip.files[jsonName].async('text');
  } else if (lowerUrl.endsWith('.gz')) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(ds);
      jsonText = await new Response(stream).text();
    } else {
      throw new Error('Gzip decompression is not supported in this browser.');
    }
  } else {
    jsonText = new TextDecoder().decode(bytes);
  }

  const parsed = JSON.parse(jsonText);
  if (Array.isArray(parsed)) {
    return parsed as RawPackEntryInput[];
  }
  if (parsed && Array.isArray(parsed.entries)) {
    return parsed.entries as RawPackEntryInput[];
  }
  throw new Error('Unexpected pack bundle format.');
}

function getBundledStarterInput(languageId: string): RawPackEntryInput[] {
  if (languageId === 'ja') {
    return JAPANESE_DICTIONARY_SAMPLE.map((entry) => ({
      id: entry.id,
      word: entry.word,
      readings: entry.readings,
      meanings: entry.meanings,
      partsOfSpeech: entry.partsOfSpeech,
      level: entry.level,
      frequencyRank: entry.frequencyRank,
    }));
  }

  const starter: StarterLexiconEntry[] = STARTER_LEXICONS[languageId] || [];
  return starter.map((entry) => ({
    word: entry.word,
    readings: entry.readings,
    meanings: entry.meanings,
    partsOfSpeech: entry.partsOfSpeech,
    level: entry.level,
    frequencyRank: entry.frequencyRank,
    aliases: entry.aliases,
  }));
}

export async function installLanguagePack(
  languageId: string,
  options?: {
    signal?: AbortSignal;
    mode?: 'auto' | 'cloud-strict' | 'starter';
    manifestUrl?: string;
    onProgress?: (progress: PackInstallProgress) => void;
  }
): Promise<PackInstallResult> {
  const signal = options?.signal;
  const mode = options?.mode ?? 'auto';
  const onProgress = options?.onProgress;
  const pack = getLanguagePack(languageId);

  throwIfAborted(signal);
  onProgress?.({ percent: 5, stage: `Preparing ${pack.name} pack...` });

  let rawEntries: RawPackEntryInput[] = [];
  let resolvedSource: 'starter' | 'cloud' | 'bundled' = 'starter';
  let resolvedVersion = pack.packVersion || '1.0.0';
  let resolvedSizeBytes = pack.packSizeBytes || 0;
  let usedManifestUrl: string | undefined;

  const shouldTryCloud =
    mode !== 'starter' &&
    typeof fetch !== 'undefined' &&
    (typeof navigator === 'undefined' || navigator.onLine !== false);

  if (shouldTryCloud) {
    try {
      onProgress?.({ percent: 12, stage: 'Checking pack manifest...' });
      const manifestUrl = options?.manifestUrl || (await getPackManifestUrl());
      const manifest = await fetchCloudPackManifest(manifestUrl, signal);
      throwIfAborted(signal);

      const manifestEntry = manifest?.packs?.[languageId];
      if (manifestEntry?.bundleUrl) {
        rawEntries = await streamAndParseCloudBundle(manifestEntry.bundleUrl, signal, onProgress);
        resolvedSource = 'cloud';
        resolvedVersion = manifestEntry.version || resolvedVersion;
        resolvedSizeBytes = manifestEntry.sizeBytes || resolvedSizeBytes;
        usedManifestUrl = manifestUrl;
      } else if (mode === 'cloud-strict') {
        throw new Error(`No cloud pack entry found for ${pack.name} in manifest.`);
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (mode === 'cloud-strict') {
        throw err;
      }
      // In 'auto' mode, cleanly fall back to bundled starter dataset
    }
  }

  throwIfAborted(signal);

  if (rawEntries.length === 0) {
    onProgress?.({ percent: 45, stage: `Loading ${pack.name} offline pack...` });
    await new Promise((r) => setTimeout(r, 80));
    throwIfAborted(signal);
    rawEntries = getBundledStarterInput(languageId);
    resolvedSource = languageId === 'ja' ? 'bundled' : 'starter';
  }

  onProgress?.({ percent: 75, stage: `Indexing ${rawEntries.length} vocabulary entries...` });

  const importId = `pack-${languageId}-${resolvedSource}`;
  const normalizedRows = normalizeEntriesToJmdictItems(languageId, importId, rawEntries, 'dictionary');

  const now = Date.now();
  const importRecord: ImportRecord = {
    importId,
    languageCode: languageId,
    kind: 'dictionary',
    fileName: `${languageId}-${resolvedSource}-pack.json`,
    fileSize: resolvedSizeBytes || normalizedRows.length * 240,
    fingerprint: `${importId}-v${resolvedVersion}-${normalizedRows.length}`,
    date: now,
    entryCount: normalizedRows.length,
    version: resolvedVersion,
    description: `${pack.name} ${resolvedSource === 'cloud' ? 'Cloud' : 'Starter'} Vocabulary Pack`,
  };

  // Replace previous starter/cloud entries for this importId smoothly without touching study data
  await db.transaction(
    'rw',
    [db.jmdictEntries, db.imports, db.downloadedAssets, db.installedPacks],
    async () => {
      if (normalizedRows.length > 0) {
        await db.jmdictEntries.bulkPut(normalizedRows);
      }
      await db.imports.put(importRecord);

      for (const asset of pack.assetsManifest) {
        await db.downloadedAssets.put({
          packId: languageId,
          assetId: asset.id,
          name: asset.name,
          version: resolvedVersion,
          sizeBytes: asset.sizeBytes,
          installedAt: now,
        });
      }
    }
  );

  throwIfAborted(signal);
  await ensureDefaultDeck(languageId);

  const totalDbCount = await db.jmdictEntries.where('languageCode').equals(languageId).count();
  const installedRecord: InstalledLanguagePackRecord = {
    languageId,
    version: resolvedVersion,
    installedAt: now,
    updatedAt: now,
    source: resolvedSource,
    entryCount: totalDbCount || normalizedRows.length,
    sizeBytes: resolvedSizeBytes || normalizedRows.length * 240,
    subpacks: pack.assetsManifest.map((a) => a.id),
    manifestUrl: usedManifestUrl,
  };

  await db.installedPacks.put(installedRecord);
  await db.settings.put({ key: INSTALLED_PACKS_SEEDED_KEY, value: true });

  onProgress?.({ percent: 100, stage: 'Installed' });
  await logEvent('language_pack_installed', {
    languageId,
    source: resolvedSource,
    entryCount: installedRecord.entryCount,
    version: resolvedVersion,
  });

  return {
    record: installedRecord,
    source: resolvedSource,
    entryCount: installedRecord.entryCount,
  };
}

/**
 * Removes a downloaded language pack and its vocabulary/cache records cleanly.
 * Strictly preserves user flashcards, decks, lookups, documents, and word statuses.
 */
export async function removeLanguagePack(
  languageId: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  await deleteJmdictInBatches(languageId, (pct) => {
    onProgress?.(pct);
  });

  await db.transaction('rw', [db.downloadedAssets, db.installedPacks], async () => {
    const assets = await db.downloadedAssets.where('packId').equals(languageId).toArray();
    for (const a of assets) {
      await db.downloadedAssets.delete([languageId, a.assetId]);
    }
    await db.installedPacks.delete(languageId);
  });

  await db.settings.put({ key: INSTALLED_PACKS_SEEDED_KEY, value: true });

  if (languageId === 'ja' && typeof caches !== 'undefined') {
    try {
      await caches.delete('kuromoji-dict-v1');
    } catch {
      // Ignore cache API errors
    }
  }

  await logEvent('language_pack_removed', { languageId });
}

export async function clearLanguagePackCache(languageId: string): Promise<void> {
  const assets = await db.downloadedAssets.where('packId').equals(languageId).toArray();
  for (const a of assets) {
    await db.downloadedAssets.delete([languageId, a.assetId]);
  }
  if (languageId === 'ja' && typeof caches !== 'undefined') {
    try {
      await caches.delete('kuromoji-dict-v1');
    } catch {
      // Ignore
    }
  }
  await logEvent('language_pack_cache_cleared', { languageId });
}

function parseSimpleCsvLines(text: string): string[][] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const cells: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if ((ch === ',' || ch === '\t') && !inQuotes) {
        cells.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  });
}

/**
 * Developer utility: import custom JSON or CSV dictionary/frequency list for any language pack.
 */
export async function importCustomLanguageJsonOrCsv(
  languageId: string,
  content: string,
  kind: 'dictionary' | 'frequency',
  fileName = 'custom-import'
): Promise<{ importedCount: number }> {
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    throw new Error('The uploaded file is empty.');
  }

  const parsedEntries: RawPackEntryInput[] = [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    const list: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data.entries)
      ? data.entries
      : Object.entries(data).map(([word, val]: [string, any]) =>
          typeof val === 'object' && val !== null
            ? { word, ...val }
            : { word, meanings: [String(val)] }
        );

    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const word = String(item.word || item.term || item.headword || '').trim();
      if (!word) continue;
      const meaningsRaw = item.meanings ?? item.meaning ?? item.glosses ?? item.definition ?? '';
      const meanings = Array.isArray(meaningsRaw)
        ? meaningsRaw.map(String)
        : String(meaningsRaw)
            .split(/[;|]/)
            .map((s) => s.trim())
            .filter(Boolean);
      const readingsRaw = item.readings ?? item.reading ?? item.pinyin ?? '';
      const readings = Array.isArray(readingsRaw)
        ? readingsRaw.map(String)
        : String(readingsRaw)
            .split(/[;|]/)
            .map((s) => s.trim())
            .filter(Boolean);
      const rankNum = Number(item.frequencyRank ?? item.rank ?? item.freq);
      parsedEntries.push({
        word,
        readings,
        meanings: meanings.length > 0 ? meanings : kind === 'frequency' ? [`Frequency entry (${word})`] : [word],
        partsOfSpeech: Array.isArray(item.partsOfSpeech)
          ? item.partsOfSpeech
          : item.pos
          ? [String(item.pos)]
          : undefined,
        level: item.level ? String(item.level) : undefined,
        frequencyRank: Number.isFinite(rankNum) && rankNum > 0 ? rankNum : undefined,
        aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : undefined,
      });
    }
  } else {
    const rows = parseSimpleCsvLines(trimmed);
    if (rows.length === 0) throw new Error('No rows found in CSV.');
    const headerLower = rows[0].map((c) => c.toLowerCase());
    const hasHeader =
      headerLower.includes('word') ||
      headerLower.includes('term') ||
      headerLower.includes('meaning') ||
      headerLower.includes('rank') ||
      headerLower.includes('frequencyrank');

    const startIdx = hasHeader ? 1 : 0;
    const colIdx = {
      word: hasHeader ? Math.max(0, headerLower.findIndex((h) => h === 'word' || h === 'term')) : 0,
      meaning: hasHeader
        ? headerLower.findIndex((h) => h === 'meaning' || h === 'meanings' || h === 'definition')
        : kind === 'dictionary'
        ? 1
        : -1,
      reading: hasHeader ? headerLower.findIndex((h) => h === 'reading' || h === 'pinyin' || h === 'ipa') : -1,
      level: hasHeader ? headerLower.findIndex((h) => h === 'level' || h === 'cefr' || h === 'jlpt' || h === 'hsk' || h === 'topik') : -1,
      rank: hasHeader
        ? headerLower.findIndex((h) => h === 'rank' || h === 'frequencyrank' || h === 'freq')
        : kind === 'frequency'
        ? 1
        : -1,
    };

    for (let i = startIdx; i < rows.length; i++) {
      const r = rows[i];
      const word = (r[colIdx.word] || '').trim();
      if (!word) continue;
      const meaningText = colIdx.meaning >= 0 ? r[colIdx.meaning] || '' : '';
      const readingText = colIdx.reading >= 0 ? r[colIdx.reading] || '' : '';
      const levelText = colIdx.level >= 0 ? r[colIdx.level] || '' : '';
      const rankNum = colIdx.rank >= 0 ? Number(r[colIdx.rank]) : NaN;

      parsedEntries.push({
        word,
        readings: readingText ? [readingText] : [],
        meanings: meaningText
          ? meaningText.split(/[;|]/).map((s) => s.trim()).filter(Boolean)
          : kind === 'frequency'
          ? [`Rank #${Number.isFinite(rankNum) ? rankNum : i}`]
          : [word],
        level: levelText || undefined,
        frequencyRank: Number.isFinite(rankNum) && rankNum > 0 ? rankNum : undefined,
      });
    }
  }

  if (parsedEntries.length === 0) {
    throw new Error('No valid vocabulary entries were found in the uploaded file.');
  }

  const now = Date.now();
  const importId = `custom-${languageId}-${kind}-${now}`;
  const normalized = normalizeEntriesToJmdictItems(languageId, importId, parsedEntries, kind);

  const imp: ImportRecord = {
    importId,
    languageCode: languageId,
    kind,
    fileName,
    fileSize: content.length,
    fingerprint: `${importId}-${normalized.length}`,
    date: now,
    entryCount: normalized.length,
    version: 'custom',
    description: `Custom ${kind} import (${fileName})`,
  };

  await db.transaction('rw', [db.jmdictEntries, db.imports, db.installedPacks], async () => {
    await db.jmdictEntries.bulkPut(normalized);
    await db.imports.put(imp);

    const existingPack = await db.installedPacks.get(languageId);
    const totalCount = await db.jmdictEntries.where('languageCode').equals(languageId).count();
    const packMeta = getLanguagePack(languageId);
    await db.installedPacks.put({
      languageId,
      version: existingPack?.version || packMeta.packVersion || '1.0.0',
      installedAt: existingPack?.installedAt || now,
      updatedAt: now,
      source: existingPack?.source || 'custom',
      entryCount: totalCount,
      sizeBytes: (existingPack?.sizeBytes || 0) + content.length,
      subpacks: Array.from(new Set([...(existingPack?.subpacks || []), importId])),
    });
  });

  await ensureDefaultDeck(languageId);
  await logEvent('custom_pack_imported', { languageId, kind, importedCount: normalized.length });
  return { importedCount: normalized.length };
}
