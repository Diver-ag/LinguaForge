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
import { buildMandarinPinyinSegments, invalidateMandarinLexiconCache } from '../packs/multilingualPack';
import { mapFrequencyRankToLevel } from './languagePack';
import { logEvent } from './eventLogger';

export const DEFAULT_PACK_MANIFEST_URL =
  'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/manifest.json';
const LEGACY_DEFAULT_MANIFEST_URL =
  'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@main/packs/manifest.json';
export const PACK_MANIFEST_URL_KEY = 'packManifestUrl';
const INSTALLED_PACKS_SEEDED_KEY = 'installedPacksSeededV1';

export interface CloudPackManifestItem {
  version?: string;
  file?: string;
  bundleUrl?: string;
  sizeBytes?: number;
  entryCount?: number;
  checksum?: string;
}

export interface CloudPackManifest {
  manifestVersion?: string;
  updatedAt?: string;
  packs: Record<string, CloudPackManifestItem>;
}

export function resolveManifestPackUrl(
  item: CloudPackManifestItem | undefined,
  manifestUrl: string
): string | null {
  const rawRef = (item?.file || item?.bundleUrl || '').trim();
  if (!rawRef) return null;
  try {
    return new URL(rawRef, manifestUrl).toString();
  } catch {
    if (rawRef.startsWith('http://') || rawRef.startsWith('https://')) {
      return rawRef;
    }
    const base = manifestUrl.replace(/\/[^/]*$/, '/');
    return `${base}${rawRef.replace(/^\.\//, '')}`;
  }
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
      const val = row.value.trim();
      if (val === LEGACY_DEFAULT_MANIFEST_URL) {
        return DEFAULT_PACK_MANIFEST_URL;
      }
      return val;
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

export interface RawPackEntryInput {
  id?: string;
  word: string;
  traditionalForm?: string;
  readings?: string[];
  meanings: string[];
  partsOfSpeech?: string[];
  level?: string;
  frequencyRank?: number;
  aliases?: string[];
}

export function normalizeRawPackItem(
  item: unknown,
  kind: 'dictionary' | 'frequency' = 'dictionary'
): RawPackEntryInput | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, any>;

  const word = String(obj.w ?? obj.word ?? obj.term ?? obj.headword ?? '').trim();
  if (!word) return null;

  const tradRaw = typeof obj.t === 'string' ? obj.t.trim() : '';
  const traditionalForm = tradRaw && tradRaw !== word ? tradRaw : undefined;

  const readingsRaw = obj.r ?? obj.readings ?? obj.reading ?? obj.pinyin ?? '';
  const readings = Array.isArray(readingsRaw)
    ? readingsRaw.map((v) => String(v).trim()).filter(Boolean)
    : String(readingsRaw || '')
        .split(/[;|]/)
        .map((v) => v.trim())
        .filter(Boolean);

  const meaningsRaw = obj.m ?? obj.meanings ?? obj.meaning ?? obj.glosses ?? obj.definition ?? '';
  const meanings = Array.isArray(meaningsRaw)
    ? meaningsRaw.map((v) => String(v).trim()).filter(Boolean)
    : String(meaningsRaw || '')
        .split(/[;|]/)
        .map((v) => v.trim())
        .filter(Boolean);

  const posRaw = obj.p ?? obj.partsOfSpeech ?? obj.pos;
  const partsOfSpeech = Array.isArray(posRaw)
    ? posRaw.map((v) => String(v).trim()).filter(Boolean)
    : typeof posRaw === 'string' && posRaw.trim()
    ? posRaw
        .split(/[,;|]/)
        .map((v) => v.trim())
        .filter(Boolean)
    : undefined;

  const rankNum = Number(obj.f ?? obj.frequencyRank ?? obj.rank ?? obj.freq);
  const frequencyRank = Number.isFinite(rankNum) && rankNum > 0 ? Math.round(rankNum) : undefined;

  const levelRaw = obj.level ?? obj.cefr ?? obj.hsk ?? obj.topik ?? obj.jlpt;
  const level = typeof levelRaw === 'string' && levelRaw.trim() ? levelRaw.trim() : undefined;

  const aliases: string[] = Array.isArray(obj.aliases)
    ? obj.aliases.map((v) => String(v).trim()).filter(Boolean)
    : [];
  if (traditionalForm && !aliases.includes(traditionalForm)) {
    aliases.push(traditionalForm);
  }

  return {
    id: typeof obj.id === 'string' ? obj.id : undefined,
    word,
    traditionalForm,
    readings,
    meanings:
      meanings.length > 0
        ? meanings
        : kind === 'frequency'
        ? [`Frequency entry (${word})`]
        : [word],
    partsOfSpeech,
    level,
    frequencyRank,
    aliases: aliases.length > 0 ? aliases : undefined,
  };
}

export function normalizeEntriesToJmdictItems(
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
    if (raw.traditionalForm) {
      formsSet.add(raw.traditionalForm);
    }
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
    const resolvedLevel = raw.level || mapFrequencyRankToLevel(languageId, freqRank);
    const isCommon = freqRank !== undefined ? freqRank <= 2500 : true;
    const kanjiList = raw.traditionalForm
      ? [
          { text: word, common: isCommon },
          { text: raw.traditionalForm, common: isCommon },
        ]
      : [{ text: word, common: isCommon }];

    out.push({
      id: raw.id ? `${languageId}-${raw.id}` : `${importId}-${i}-${word}`,
      languageCode: languageId,
      forms: Array.from(formsSet),
      kanji: kanjiList,
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
      jlptLevel: resolvedLevel,
      importIds: [importId],
      kinds: [kind],
    });
  }
  return out;
}

export function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function decompressGzipBytesToText(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Gzip decompression (DecompressionStream) is not supported in this browser.');
  }
  const sliced = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([sliced]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

export interface ExtractedPackData {
  entries: RawPackEntryInput[];
  forms: Record<string, string[]>;
}

function normalizeFormsMap(rawForms: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!rawForms || typeof rawForms !== 'object' || Array.isArray(rawForms)) {
    return out;
  }

  for (const [rawKey, rawVal] of Object.entries(rawForms as Record<string, unknown>)) {
    const formKey = rawKey.trim().toLowerCase();
    if (!formKey) continue;

    const lemmaList = Array.isArray(rawVal)
      ? rawVal.map((v) => String(v).trim()).filter(Boolean)
      : typeof rawVal === 'string'
      ? rawVal
          .split(/[;|]/)
          .map((v) => v.trim())
          .filter(Boolean)
      : [];

    if (lemmaList.length === 0) continue;
    if (!out[formKey]) {
      out[formKey] = [];
    }
    for (const l of lemmaList) {
      if (!out[formKey].includes(l)) {
        out[formKey].push(l);
      }
    }
  }

  return out;
}

export function extractRawPackDataFromParsedJson(parsed: unknown): ExtractedPackData {
  let rawArray: unknown[] | null = null;
  let forms: Record<string, string[]> = {};

  if (Array.isArray(parsed)) {
    rawArray = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, any>;
    if (Array.isArray(obj.entries)) {
      rawArray = obj.entries;
    } else if (Array.isArray(obj.words)) {
      rawArray = obj.words;
    } else if (Array.isArray(obj.items)) {
      rawArray = obj.items;
    }
    if (obj.forms && typeof obj.forms === 'object') {
      forms = normalizeFormsMap(obj.forms);
    }
  }

  if (!rawArray) {
    throw new Error('Unexpected pack bundle format.');
  }

  const out: RawPackEntryInput[] = [];
  for (const item of rawArray) {
    const normalized = normalizeRawPackItem(item);
    if (normalized) out.push(normalized);
  }
  return { entries: out, forms };
}

export function extractRawPackEntriesFromParsedJson(parsed: unknown): RawPackEntryInput[] {
  return extractRawPackDataFromParsedJson(parsed).entries;
}

export async function storePackFormsInBatches(
  languageId: string,
  formsMap: Record<string, string[]>,
  signal?: AbortSignal
): Promise<void> {
  const entries = Object.entries(formsMap);
  if (entries.length === 0) return;

  const rows = entries.map(([form, lemmas]) => ({
    languageCode: languageId,
    form,
    lemmas,
  }));

  const BATCH_SIZE = 3000;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    throwIfAborted(signal);
    await db.packForms.bulkPut(rows.slice(i, i + BATCH_SIZE));
  }
}

async function streamAndParseCloudBundle(
  bundleUrl: string,
  expectedTotalBytes?: number,
  signal?: AbortSignal,
  onProgress?: (p: PackInstallProgress) => void
): Promise<ExtractedPackData> {
  const res = await fetch(bundleUrl, { signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while downloading pack bundle`);
  }

  const totalHeader = Number(res.headers.get('content-length') || 0) || expectedTotalBytes || 0;
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
        const pct =
          totalHeader > 0
            ? Math.min(72, Math.max(15, Math.round((loaded / totalHeader) * 72)))
            : 35;
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
    onProgress?.({ percent: 72, stage: 'Downloaded pack bundle' });
  }

  throwIfAborted(signal);
  onProgress?.({ percent: 75, stage: 'Decompressing pack...' });

  let jsonText = '';
  const lowerUrl = bundleUrl.toLowerCase();

  if (lowerUrl.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(bytes);
    const jsonName = Object.keys(zip.files).find((n) => n.endsWith('.json') && !zip.files[n].dir);
    if (!jsonName) {
      throw new Error('Pack archive does not contain a JSON dictionary file.');
    }
    jsonText = await zip.files[jsonName].async('text');
  } else if (lowerUrl.endsWith('.gz') || isGzipBytes(bytes)) {
    jsonText = await decompressGzipBytesToText(bytes);
  } else {
    jsonText = new TextDecoder().decode(bytes);
  }

  throwIfAborted(signal);
  const parsed = JSON.parse(jsonText);
  return extractRawPackDataFromParsedJson(parsed);
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
  let rawForms: Record<string, string[]> = {};
  let resolvedSource: 'starter' | 'cloud' | 'bundled' = 'starter';
  let resolvedVersion = pack.packVersion || '1.0.0';
  let resolvedSizeBytes = pack.packSizeBytes || 0;
  let usedManifestUrl: string | undefined;

  const shouldTryCloud =
    mode !== 'starter' &&
    typeof fetch !== 'undefined' &&
    (typeof navigator === 'undefined' || navigator.onLine !== false);

  const manifestUrl = (options?.manifestUrl || (await getPackManifestUrl())).trim();

  if (shouldTryCloud) {
    try {
      onProgress?.({ percent: 10, stage: 'Fetching pack manifest...' });
      const manifest = await fetchCloudPackManifest(manifestUrl, signal);
      throwIfAborted(signal);

      if (!manifest && mode === 'cloud-strict') {
        throw new Error('Could not reach cloud pack manifest. Check connection or use offline starter.');
      }

      const manifestEntry = manifest?.packs?.[languageId];
      const resolvedUrl = resolveManifestPackUrl(manifestEntry, manifestUrl);
      if (resolvedUrl) {
        const bundleData = await streamAndParseCloudBundle(
          resolvedUrl,
          manifestEntry?.sizeBytes,
          signal,
          onProgress
        );
        rawEntries = bundleData.entries;
        rawForms = bundleData.forms;
        resolvedSource = 'cloud';
        resolvedVersion = manifestEntry?.version || resolvedVersion;
        resolvedSizeBytes = manifestEntry?.sizeBytes || resolvedSizeBytes;
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
  } else if (mode === 'cloud-strict') {
    throw new Error('You appear to be offline. Connect to download or install the offline starter pack.');
  }

  throwIfAborted(signal);

  if (rawEntries.length === 0) {
    onProgress?.({ percent: 45, stage: `Loading ${pack.name} offline pack...` });
    await new Promise((r) => setTimeout(r, 80));
    throwIfAborted(signal);
    rawEntries = getBundledStarterInput(languageId);
    resolvedSource = languageId === 'ja' ? 'bundled' : 'starter';
  }

  onProgress?.({ percent: 80, stage: `Indexing ${rawEntries.length.toLocaleString()} vocabulary entries...` });

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

  // Batch IndexedDB writes in chunks so large cloud packs don't freeze the UI thread
  const BATCH_SIZE = 2000;
  for (let i = 0; i < normalizedRows.length; i += BATCH_SIZE) {
    throwIfAborted(signal);
    const slice = normalizedRows.slice(i, i + BATCH_SIZE);
    await db.jmdictEntries.bulkPut(slice);
    const ratio = (i + slice.length) / Math.max(1, normalizedRows.length);
    onProgress?.({
      percent: Math.min(94, 80 + Math.round(ratio * 14)),
      stage: `Storing offline dictionary (${Math.min(i + slice.length, normalizedRows.length).toLocaleString()} / ${normalizedRows.length.toLocaleString()})...`,
    });
  }

  if (Object.keys(rawForms).length > 0) {
    onProgress?.({ percent: 96, stage: 'Indexing inflection forms...' });
    await db.packForms.where('languageCode').equals(languageId).delete();
    await storePackFormsInBatches(languageId, rawForms, signal);
  }

  // Record metadata without touching flashcards, decks, lookups, or documents
  await db.transaction(
    'rw',
    [db.imports, db.downloadedAssets, db.installedPacks],
    async () => {
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
  if (languageId === 'zh') {
    invalidateMandarinLexiconCache();
  }

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
  try {
    const bundleStatusRow = await db.settings.get('installedBundledPacksMap');
    if (bundleStatusRow?.value && typeof bundleStatusRow.value === 'object') {
      const nextMap: Record<string, any> = {};
      for (const [k, v] of Object.entries(bundleStatusRow.value)) {
        if ((v as any)?.languageId !== languageId) {
          nextMap[k] = v;
        }
      }
      await db.settings.put({ key: 'installedBundledPacksMap', value: nextMap });
    }
  } catch {
    // Ignore DB errors
  }

  if (languageId === 'zh') {
    invalidateMandarinLexiconCache();
  }
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
  let parsedForms: Record<string, string[]> = {};

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    if (Array.isArray(data) || Array.isArray(data?.entries) || Array.isArray(data?.words) || Array.isArray(data?.items)) {
      const extracted = extractRawPackDataFromParsedJson(data);
      parsedEntries.push(...extracted.entries);
      parsedForms = extracted.forms;
    } else {
      const list: any[] = Object.entries(data).map(([word, val]: [string, any]) =>
        typeof val === 'object' && val !== null
          ? { word, ...val }
          : { word, meanings: [String(val)] }
      );
      for (const item of list) {
        const normalizedItem = normalizeRawPackItem(item, kind);
        if (normalizedItem) {
          parsedEntries.push(normalizedItem);
        }
      }
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

  const BATCH_SIZE = 2000;
  for (let i = 0; i < normalized.length; i += BATCH_SIZE) {
    await db.jmdictEntries.bulkPut(normalized.slice(i, i + BATCH_SIZE));
  }
  if (Object.keys(parsedForms).length > 0) {
    await storePackFormsInBatches(languageId, parsedForms);
  }
  if (languageId === 'zh') {
    invalidateMandarinLexiconCache();
  }

  const totalCount = await db.jmdictEntries.where('languageCode').equals(languageId).count();

  await db.transaction('rw', [db.imports, db.installedPacks], async () => {
    await db.imports.put(imp);

    const existingPack = await db.installedPacks.get(languageId);
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

/**
 * Developer utility: imports a local .json, .json.gz, .csv, .tsv, or .txt pack file.
 */
export async function importCustomLanguageFile(
  languageId: string,
  file: File,
  kind: 'dictionary' | 'frequency'
): Promise<{ importedCount: number }> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let text = '';
  if (file.name.toLowerCase().endsWith('.gz') || isGzipBytes(bytes)) {
    text = await decompressGzipBytesToText(bytes);
  } else {
    text = new TextDecoder().decode(bytes);
  }
  return importCustomLanguageJsonOrCsv(languageId, text, kind, file.name);
}

/**
 * Developer utility: adds or removes an individual sub-pack component for a language.
 */
export async function toggleLanguageSubpack(
  languageId: string,
  assetId: string,
  action: 'add' | 'remove'
): Promise<void> {
  const pack = getLanguagePack(languageId);
  const asset = pack.assetsManifest.find((a) => a.id === assetId);
  if (!asset) return;

  const now = Date.now();
  if (action === 'add') {
    await db.downloadedAssets.put({
      packId: languageId,
      assetId: asset.id,
      name: asset.name,
      version: asset.version || pack.packVersion || '1.0.0',
      sizeBytes: asset.sizeBytes,
      installedAt: now,
    });
    const existing = await db.installedPacks.get(languageId);
    const subpacks = Array.from(new Set([...(existing?.subpacks || []), assetId]));
    await db.installedPacks.put({
      languageId,
      version: existing?.version || pack.packVersion || '1.0.0',
      installedAt: existing?.installedAt || now,
      updatedAt: now,
      source: existing?.source || (languageId === 'ja' ? 'bundled' : 'starter'),
      entryCount: existing?.entryCount || 0,
      sizeBytes: (existing?.sizeBytes || 0) + asset.sizeBytes,
      subpacks,
      manifestUrl: existing?.manifestUrl,
    });
    await ensureDefaultDeck(languageId);
  } else {
    await db.downloadedAssets.delete([languageId, assetId]);
    const existing = await db.installedPacks.get(languageId);
    if (existing) {
      const nextSubpacks = (existing.subpacks || []).filter((id) => id !== assetId);
      await db.installedPacks.put({
        ...existing,
        updatedAt: now,
        subpacks: nextSubpacks,
      });
    }
  }
}
