import {
  db,
  deleteImportInBatches,
  type CustomPackAssetItem,
  type ImportRecord,
  type InstalledLanguagePackRecord,
  type JmdictEntryItem,
  type KanjiEntryItem,
} from '../db/db';
import { ensureDefaultDeck } from '../db/cards';
import { getAllLanguagePacks, getLanguagePack } from '../packs/registry';
import { deriveBandFromRank } from '../packs/japanese/jmdictFrequency';
import { isEasierLevel } from '../packs/japanese/kanjiListParser';
import { invalidateMandarinLexiconCache } from '../packs/multilingualPack';
import { mapFrequencyRankToLevel } from './languagePack';
import { logEvent } from './eventLogger';
import {
  DEFAULT_PACK_MANIFEST_URL,
  decompressGzipBytesToText,
  extractRawPackDataFromParsedJson,
  installLanguagePack,
  isAbortError,
  isGzipBytes,
  normalizeEntriesToJmdictItems,
  storePackFormsInBatches,
} from './packManager';
import {
  BUNDLED_PACK_CATEGORY_LABELS,
  detectCategoryColumnMapping,
  extractDictRowsFromTable,
  extractExampleRowsFromTable,
  extractFrequencyRowsFromTable,
  extractKanjiRowsFromTable,
  parseDelimitedPackTable,
  stripUtf8Bom,
  type BundledPackCategory,
  type ParsedDictCsvRow,
  type ParsedExampleCsvRow,
  type ParsedFrequencyCsvRow,
  type ParsedKanjiCsvRow,
} from './packCsvParser';

export type { BundledPackCategory };
export { BUNDLED_PACK_CATEGORY_LABELS };

export type BundledPackSourceType = 'cloud-v2' | 'url' | 'public-file' | 'custom-asset';
export type BundledPackFormat = 'json' | 'json.gz' | 'csv' | 'tsv' | 'v2';

export interface BundledPackDefinition {
  id: string;
  languageId: string;
  category: BundledPackCategory;
  title: string;
  description?: string;
  url?: string;
  sourceType: BundledPackSourceType;
  fileFormat?: BundledPackFormat;
  sizeBytes?: number;
  entryCount?: number;
  version?: string;
  origin: 'default' | 'auto-discovered' | 'custom';
  customAssetId?: string;
  columnMapping?: Record<string, number>;
}

export interface BundledPacksCustomizations {
  removedIds: string[];
  customPacks: BundledPackDefinition[];
}

export interface InstalledBundledPackStatus {
  packId: string;
  languageId: string;
  category: BundledPackCategory;
  importId: string;
  installedAt: number;
  entryCount: number;
  version?: string;
}

export interface LanguageBundleInstallProgress {
  languageId: string;
  currentIndex: number;
  totalCount: number;
  currentPack: BundledPackDefinition;
  percent: number;
  stage: string;
}

export interface AllLanguagesBundleInstallProgress {
  languageIndex: number;
  totalLanguages: number;
  currentLanguageId: string;
  languageProgress: LanguageBundleInstallProgress;
  overallPercent: number;
  stage: string;
}

export const BUNDLED_PACKS_CUSTOMIZATIONS_KEY = 'bundledPacksCustomizations';
export const INSTALLED_BUNDLED_PACKS_KEY = 'installedBundledPacksMap';
const LOCAL_STORAGE_CUSTOMIZATIONS_KEY = 'linguaforge:bundledPacksCustomizations';

export const BUNDLED_PACK_INSTALL_ORDER: Record<BundledPackCategory, number> = {
  'core-dict': 1,
  'common-dict': 2,
  'kanji-levels': 3,
  examples: 4,
  frequency: 5,
};

const SUPPORTED_LANG_IDS = ['ja', 'es', 'de', 'fr', 'it', 'pt', 'tr', 'nl', 'ko', 'zh'] as const;
const SUPPORTED_LANG_SET = new Set<string>(SUPPORTED_LANG_IDS);

function buildDefaultCloudUrl(langId: string): string {
  const base = DEFAULT_PACK_MANIFEST_URL.replace(/\/manifest\.json$/, '');
  return `${base}/${langId}.json.gz`;
}

/**
 * Immutable author-shipped default registry used offline and as baseline for Restore Defaults.
 */
export const DEFAULT_BUNDLED_PACKS: readonly BundledPackDefinition[] = Object.freeze([
  {
    id: 'default-ja-core-dict',
    languageId: 'ja',
    category: 'core-dict',
    title: 'Japanese Core Dictionary (v2.1)',
    description: 'Core Japanese-English dictionary & inflection forms.',
    sourceType: 'cloud-v2',
    url: buildDefaultCloudUrl('ja'),
    fileFormat: 'v2',
    origin: 'default',
  },
  {
    id: 'default-ja-kanji-levels',
    languageId: 'ja',
    category: 'kanji-levels',
    title: 'Kanji & JLPT Levels Starter',
    description: 'JLPT N5-N1 kanji characters with readings, meanings, and stroke counts.',
    sourceType: 'public-file',
    url: '/packs/ja-kanji-levels.csv',
    fileFormat: 'csv',
    origin: 'default',
  },
  {
    id: 'default-ja-examples',
    languageId: 'ja',
    category: 'examples',
    title: 'Japanese Example Sentences',
    description: 'Contextual Japanese-English sentence pairs linked to core vocabulary.',
    sourceType: 'public-file',
    url: '/packs/ja-examples.csv',
    fileFormat: 'csv',
    origin: 'default',
  },
  {
    id: 'default-ja-frequency',
    languageId: 'ja',
    category: 'frequency',
    title: 'Japanese Frequency Ranks',
    description: 'Word frequency ranks and bands for core Japanese vocabulary.',
    sourceType: 'public-file',
    url: '/packs/ja-frequency.csv',
    fileFormat: 'csv',
    origin: 'default',
  },
  {
    id: 'default-es-core-dict',
    languageId: 'es',
    category: 'core-dict',
    title: 'Spanish Core Dictionary (v2.1)',
    description: 'Spanish-English dictionary & verb inflection forms.',
    sourceType: 'cloud-v2',
    url: buildDefaultCloudUrl('es'),
    fileFormat: 'v2',
    origin: 'default',
  },
  {
    id: 'default-es-examples',
    languageId: 'es',
    category: 'examples',
    title: 'Spanish Example Sentences',
    description: 'Contextual Spanish-English example sentence pairs.',
    sourceType: 'public-file',
    url: '/packs/es-examples.csv',
    fileFormat: 'csv',
    origin: 'default',
  },
  {
    id: 'default-de-core-dict',
    languageId: 'de',
    category: 'core-dict',
    title: 'German Core Dictionary (v2.1)',
    description: 'German-English dictionary & inflection forms.',
    sourceType: 'cloud-v2',
    url: buildDefaultCloudUrl('de'),
    fileFormat: 'v2',
    origin: 'default',
  },
  {
    id: 'default-de-examples',
    languageId: 'de',
    category: 'examples',
    title: 'German Example Sentences',
    description: 'Contextual German-English example sentence pairs.',
    sourceType: 'public-file',
    url: '/packs/de-examples.csv',
    fileFormat: 'csv',
    origin: 'default',
  },
  {
    id: 'default-fr-core-dict',
    languageId: 'fr',
    category: 'core-dict',
    title: 'French Core Dictionary (v2.1)',
    description: 'French-English dictionary & inflection forms.',
    sourceType: 'cloud-v2',
    url: buildDefaultCloudUrl('fr'),
    fileFormat: 'v2',
    origin: 'default',
  },
  {
    id: 'default-fr-examples',
    languageId: 'fr',
    category: 'examples',
    title: 'French Example Sentences',
    description: 'Contextual French-English example sentence pairs.',
    sourceType: 'public-file',
    url: '/packs/fr-examples.csv',
    fileFormat: 'csv',
    origin: 'default',
  },
  {
    id: 'default-it-core-dict',
    languageId: 'it',
    category: 'core-dict',
    title: 'Italian Core Dictionary (v2.1)',
    description: 'Italian-English dictionary & inflection forms.',
    sourceType: 'cloud-v2',
    url: buildDefaultCloudUrl('it'),
    fileFormat: 'v2',
    origin: 'default',
  },
  {
    id: 'default-pt-core-dict',
    languageId: 'pt',
    category: 'core-dict',
    title: 'Portuguese Core Dictionary (v2.1)',
    description: 'Portuguese-English dictionary & inflection forms.',
    sourceType: 'cloud-v2',
    url: buildDefaultCloudUrl('pt'),
    fileFormat: 'v2',
    origin: 'default',
  },
  {
    id: 'default-tr-core-dict',
    languageId: 'tr',
    category: 'core-dict',
    title: 'Turkish Core Dictionary (v2.1)',
    description: 'Turkish-English dictionary & inflection forms.',
    sourceType: 'cloud-v2',
    url: buildDefaultCloudUrl('tr'),
    fileFormat: 'v2',
    origin: 'default',
  },
  {
    id: 'default-nl-core-dict',
    languageId: 'nl',
    category: 'core-dict',
    title: 'Dutch Core Dictionary (v2.1)',
    description: 'Dutch-English dictionary & inflection forms.',
    sourceType: 'cloud-v2',
    url: buildDefaultCloudUrl('nl'),
    fileFormat: 'v2',
    origin: 'default',
  },
  {
    id: 'default-ko-core-dict',
    languageId: 'ko',
    category: 'core-dict',
    title: 'Korean Core Dictionary (v2.1)',
    description: 'Korean-English dictionary & inflection forms.',
    sourceType: 'cloud-v2',
    url: buildDefaultCloudUrl('ko'),
    fileFormat: 'v2',
    origin: 'default',
  },
  {
    id: 'default-zh-core-dict',
    languageId: 'zh',
    category: 'core-dict',
    title: 'Mandarin Core Dictionary (v2.1)',
    description: 'Mandarin CC-CEDICT dictionary & tone-marked Pinyin.',
    sourceType: 'cloud-v2',
    url: buildDefaultCloudUrl('zh'),
    fileFormat: 'v2',
    origin: 'default',
  },
]);

function normalizePackUrlForCompare(rawUrl?: string): string {
  if (!rawUrl) return '';
  let clean = rawUrl.trim();
  if (clean.startsWith('/public/packs/')) {
    clean = clean.slice('/public'.length);
  }
  return clean.split('?')[0].toLowerCase();
}

function normalizeFetchUrl(filePath: string, resolvedUrl: string): string {
  const trimmed = (resolvedUrl || '').trim();
  if (trimmed.startsWith('data:') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  if (trimmed.startsWith('/public/packs/')) {
    return trimmed.slice('/public'.length);
  }
  if (trimmed.startsWith('/packs/')) {
    return trimmed;
  }
  if (filePath.startsWith('/public/packs/')) {
    return filePath.slice('/public'.length);
  }
  return trimmed || filePath;
}

export function detectPackFileFormat(fileNameOrUrl: string): BundledPackFormat | null {
  const lower = fileNameOrUrl.toLowerCase().split('?')[0];
  if (lower.endsWith('.json.gz')) return 'json.gz';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.tsv')) return 'tsv';
  return null;
}

export function classifyDiscoveredPackPath(
  filePath: string,
  resolvedUrl?: string
): BundledPackDefinition | null {
  const cleanPath = filePath.replace(/\\/g, '/');
  const format = detectPackFileFormat(cleanPath);
  if (!format) return null;

  const segments = cleanPath.split('/').filter(Boolean);
  const fileName = segments[segments.length - 1] || '';
  const lowerFile = fileName.toLowerCase();

  // Detect language from subdirectory `/packs/<lang>/...` or filename prefix `ja-`, `es_`, etc.
  let languageId: string | null = null;
  const packsIdx = segments.findIndex((s) => s.toLowerCase() === 'packs');
  if (packsIdx >= 0 && packsIdx + 2 < segments.length) {
    const dirLang = segments[packsIdx + 1].toLowerCase();
    if (SUPPORTED_LANG_SET.has(dirLang)) {
      languageId = dirLang;
    }
  }
  if (!languageId) {
    const prefixMatch = lowerFile.match(/^([a-z]{2})[-_]/);
    if (prefixMatch && SUPPORTED_LANG_SET.has(prefixMatch[1])) {
      languageId = prefixMatch[1];
    }
  }
  if (!languageId) return null;

  // Classify pack category
  let category: BundledPackCategory = 'core-dict';
  if (/kanji|jlpt/i.test(lowerFile)) {
    category = 'kanji-levels';
  } else if (/example|tatoeba|sentence/i.test(lowerFile)) {
    category = 'examples';
  } else if (/freq/i.test(lowerFile)) {
    category = 'frequency';
  } else if (/common/i.test(lowerFile)) {
    category = 'common-dict';
  } else {
    category = 'core-dict';
  }

  const slug = lowerFile.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const langMeta = getLanguagePack(languageId);
  const catLabel = BUNDLED_PACK_CATEGORY_LABELS[category];
  const fetchUrl = normalizeFetchUrl(cleanPath, resolvedUrl || cleanPath);

  return {
    id: `auto-${languageId}-${category}-${slug}`,
    languageId,
    category,
    title: `${langMeta.name} ${catLabel} (${fileName})`,
    description: `Auto-discovered ${format.toUpperCase()} bundle from /packs/${fileName}`,
    url: fetchUrl,
    sourceType: 'public-file',
    fileFormat: format,
    origin: 'auto-discovered',
  };
}

export function discoverPacksFromGlobMap(
  globMap: Record<string, string>
): BundledPackDefinition[] {
  const out: BundledPackDefinition[] = [];
  for (const [pathKey, resolvedUrl] of Object.entries(globMap)) {
    const classified = classifyDiscoveredPackPath(pathKey, resolvedUrl);
    if (classified) {
      out.push(classified);
    }
  }
  return out;
}

function getViteGlobbedPackUrls(): Record<string, string> {
  try {
    const globbed = import.meta.glob('/public/packs/**/*', {
      query: '?url',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    return globbed && typeof globbed === 'object' ? globbed : {};
  } catch {
    return {};
  }
}

let cachedManifestPacks: BundledPackDefinition[] | null = null;

export async function fetchBundledPacksManifest(): Promise<BundledPackDefinition[]> {
  if (cachedManifestPacks) return cachedManifestPacks;
  if (typeof fetch === 'undefined') return [...DEFAULT_BUNDLED_PACKS];

  try {
    const res = await fetch('/bundled-packs.json', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [...DEFAULT_BUNDLED_PACKS];
    const data = await res.json();
    if (!data || !Array.isArray(data.packs)) {
      return [...DEFAULT_BUNDLED_PACKS];
    }
    const parsed: BundledPackDefinition[] = [];
    for (const raw of data.packs) {
      if (!raw || !raw.id || !raw.languageId || !raw.category) continue;
      parsed.push({
        id: String(raw.id),
        languageId: String(raw.languageId),
        category: raw.category as BundledPackCategory,
        title: String(raw.title || raw.id),
        description: raw.description ? String(raw.description) : undefined,
        url: raw.url ? String(raw.url) : undefined,
        sourceType: (raw.sourceType || 'public-file') as BundledPackSourceType,
        fileFormat: raw.fileFormat as BundledPackFormat | undefined,
        sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : undefined,
        entryCount: typeof raw.entryCount === 'number' ? raw.entryCount : undefined,
        version: raw.version ? String(raw.version) : undefined,
        origin: 'default',
      });
    }
    cachedManifestPacks = parsed.length > 0 ? parsed : [...DEFAULT_BUNDLED_PACKS];
    return cachedManifestPacks;
  } catch {
    return [...DEFAULT_BUNDLED_PACKS];
  }
}

export function getAutoDiscoveredBasePacks(
  manifestPacks: readonly BundledPackDefinition[] = DEFAULT_BUNDLED_PACKS,
  globOverride?: Record<string, string>
): BundledPackDefinition[] {
  const globMap = globOverride ?? getViteGlobbedPackUrls();
  const discovered = discoverPacksFromGlobMap(globMap);

  const merged: BundledPackDefinition[] = manifestPacks.map((p) => ({ ...p }));
  const byNormalizedUrl = new Map<string, number>();
  const byId = new Map<string, number>();

  merged.forEach((p, idx) => {
    byId.set(p.id, idx);
    const normUrl = normalizePackUrlForCompare(p.url);
    if (normUrl) byNormalizedUrl.set(normUrl, idx);
  });

  for (const item of discovered) {
    // Match against manifest `/packs/...` paths (using original path slug when Vite inlined data: URL)
    const fallbackPublicUrl = `/packs/${item.id.split('-').slice(3).join('-')}`;
    const normItemUrl = normalizePackUrlForCompare(item.url);
    const matchIdx =
      byId.get(item.id) ??
      (normItemUrl ? byNormalizedUrl.get(normItemUrl) : undefined) ??
      merged.findIndex(
        (m) =>
          m.languageId === item.languageId &&
          m.category === item.category &&
          m.sourceType === 'public-file' &&
          normalizePackUrlForCompare(m.url) ===
            normalizePackUrlForCompare(
              item.title.match(/\(([^)]+)\)$/)?.[1]
                ? `/packs/${item.title.match(/\(([^)]+)\)$/)?.[1]}`
                : fallbackPublicUrl
            )
      );

    if (matchIdx !== undefined && matchIdx >= 0) {
      // Preserve manifest friendly title/id while using Vite's resolved URL (including data URLs in prod)
      if (item.url) {
        merged[matchIdx].url = item.url;
      }
    } else {
      merged.push(item);
      byId.set(item.id, merged.length - 1);
      if (normItemUrl) byNormalizedUrl.set(normItemUrl, merged.length - 1);
    }
  }

  return merged;
}

export async function getBundledPacksCustomizations(): Promise<BundledPacksCustomizations> {
  try {
    const row = await db.settings.get(BUNDLED_PACKS_CUSTOMIZATIONS_KEY);
    if (row && row.value && typeof row.value === 'object') {
      return {
        removedIds: Array.isArray(row.value.removedIds) ? row.value.removedIds : [],
        customPacks: Array.isArray(row.value.customPacks) ? row.value.customPacks : [],
      };
    }
  } catch {
    // Fall back to localStorage
  }

  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_CUSTOMIZATIONS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          removedIds: Array.isArray(parsed?.removedIds) ? parsed.removedIds : [],
          customPacks: Array.isArray(parsed?.customPacks) ? parsed.customPacks : [],
        };
      }
    } catch {
      // Ignore parse errors
    }
  }

  return { removedIds: [], customPacks: [] };
}

export async function saveBundledPacksCustomizations(
  next: BundledPacksCustomizations
): Promise<BundledPacksCustomizations> {
  const clean: BundledPacksCustomizations = {
    removedIds: Array.from(new Set(next.removedIds.filter(Boolean))),
    customPacks: next.customPacks.filter((p) => Boolean(p && p.id && p.languageId)),
  };

  try {
    await db.settings.put({ key: BUNDLED_PACKS_CUSTOMIZATIONS_KEY, value: clean });
  } catch {
    // Ignore DB errors
  }

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(LOCAL_STORAGE_CUSTOMIZATIONS_KEY, JSON.stringify(clean));
    } catch {
      // Ignore quota errors
    }
  }

  return clean;
}

function sortBundledPacks(packs: BundledPackDefinition[]): BundledPackDefinition[] {
  const langOrder = new Map(getAllLanguagePacks().map((p, i) => [p.id, i]));
  return [...packs].sort((a, b) => {
    const la = langOrder.get(a.languageId) ?? 99;
    const lb = langOrder.get(b.languageId) ?? 99;
    if (la !== lb) return la - lb;
    const ca = BUNDLED_PACK_INSTALL_ORDER[a.category] ?? 99;
    const cb = BUNDLED_PACK_INSTALL_ORDER[b.category] ?? 99;
    if (ca !== cb) return ca - cb;
    return a.title.localeCompare(b.title);
  });
}

export async function getEffectiveBundledPacks(options?: {
  globOverride?: Record<string, string>;
  skipRemoteManifest?: boolean;
}): Promise<{
  packs: BundledPackDefinition[];
  removedDefaultIds: string[];
  allBasePacks: BundledPackDefinition[];
}> {
  const manifestPacks = options?.skipRemoteManifest
    ? [...DEFAULT_BUNDLED_PACKS]
    : await fetchBundledPacksManifest();
  const allBasePacks = getAutoDiscoveredBasePacks(manifestPacks, options?.globOverride);
  const customizations = await getBundledPacksCustomizations();
  const removedSet = new Set(customizations.removedIds);

  const activeBase = allBasePacks.filter((p) => !removedSet.has(p.id));
  const combined = sortBundledPacks([...activeBase, ...customizations.customPacks]);

  return {
    packs: combined,
    removedDefaultIds: customizations.removedIds,
    allBasePacks: sortBundledPacks(allBasePacks),
  };
}

export async function getIncludedPacksForLanguage(
  languageId: string,
  options?: { globOverride?: Record<string, string>; skipRemoteManifest?: boolean }
): Promise<BundledPackDefinition[]> {
  const { packs } = await getEffectiveBundledPacks(options);
  return packs.filter((p) => p.languageId === languageId);
}

export async function getInstalledBundledPacksMap(): Promise<
  Record<string, InstalledBundledPackStatus>
> {
  try {
    const row = await db.settings.get(INSTALLED_BUNDLED_PACKS_KEY);
    if (row && row.value && typeof row.value === 'object') {
      return row.value as Record<string, InstalledBundledPackStatus>;
    }
  } catch {
    // Ignore DB errors
  }
  return {};
}

async function markBundledPackInstalled(status: InstalledBundledPackStatus): Promise<void> {
  const current = await getInstalledBundledPacksMap();
  current[status.packId] = status;
  await db.settings.put({ key: INSTALLED_BUNDLED_PACKS_KEY, value: current });
}

export async function clearBundledPackInstalledStatus(packId: string): Promise<void> {
  const current = await getInstalledBundledPacksMap();
  if (current[packId]) {
    delete current[packId];
    await db.settings.put({ key: INSTALLED_BUNDLED_PACKS_KEY, value: current });
  }
}

export async function addCustomBundledPackByUrl(input: {
  languageId: string;
  category: BundledPackCategory;
  title: string;
  url: string;
  description?: string;
}): Promise<BundledPackDefinition> {
  const url = input.url.trim();
  if (!url) throw new Error('Pack path or URL is required.');
  const format = detectPackFileFormat(url) || 'json';
  const id = `custom-url-${input.languageId}-${input.category}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;

  const def: BundledPackDefinition = {
    id,
    languageId: input.languageId,
    category: input.category,
    title: input.title.trim() || `${getLanguagePack(input.languageId).name} ${BUNDLED_PACK_CATEGORY_LABELS[input.category]}`,
    description: input.description?.trim() || `Custom pack from ${url}`,
    url,
    sourceType: url.startsWith('/packs/') ? 'public-file' : 'url',
    fileFormat: format,
    origin: 'custom',
  };

  const current = await getBundledPacksCustomizations();
  await saveBundledPacksCustomizations({
    removedIds: current.removedIds,
    customPacks: [...current.customPacks, def],
  });

  await logEvent('developer_pack_added', { id: def.id, languageId: def.languageId, category: def.category, url });
  return def;
}

export async function addCustomBundledPackFromFile(input: {
  languageId: string;
  category: BundledPackCategory;
  title: string;
  fileName: string;
  mimeType?: string;
  data: Uint8Array | string;
  sizeBytes?: number;
  columnMapping?: Record<string, number>;
}): Promise<BundledPackDefinition> {
  const format = detectPackFileFormat(input.fileName) || 'json';
  const id = `custom-file-${input.languageId}-${input.category}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const sizeBytes =
    input.sizeBytes ??
    (typeof input.data === 'string'
      ? new TextEncoder().encode(input.data).byteLength
      : input.data.byteLength);

  const asset: CustomPackAssetItem = {
    id,
    languageId: input.languageId,
    category: input.category,
    title: input.title.trim() || input.fileName,
    fileName: input.fileName,
    mimeType: input.mimeType || 'application/octet-stream',
    sizeBytes,
    data: input.data,
    columnMapping: input.columnMapping,
    createdAt: Date.now(),
  };

  await db.customPackAssets.put(asset);

  const def: BundledPackDefinition = {
    id,
    languageId: input.languageId,
    category: input.category,
    title: asset.title,
    description: `Uploaded ${format.toUpperCase()} (${input.fileName})`,
    url: `indexeddb://customPackAssets/${id}`,
    sourceType: 'custom-asset',
    fileFormat: format,
    sizeBytes,
    origin: 'custom',
    customAssetId: id,
    columnMapping: input.columnMapping,
  };

  const current = await getBundledPacksCustomizations();
  await saveBundledPacksCustomizations({
    removedIds: current.removedIds,
    customPacks: [...current.customPacks, def],
  });

  await logEvent('developer_pack_uploaded', {
    id: def.id,
    languageId: def.languageId,
    category: def.category,
    fileName: input.fileName,
  });
  return def;
}

export async function removeBundledPackFromRegistry(
  packId: string,
  options?: { clearDbEntries?: boolean }
): Promise<void> {
  const { allBasePacks, packs } = await getEffectiveBundledPacks({ skipRemoteManifest: true });
  const targetPack =
    packs.find((p) => p.id === packId) || allBasePacks.find((p) => p.id === packId);

  const current = await getBundledPacksCustomizations();
  const isCustom = current.customPacks.some((p) => p.id === packId);

  if (isCustom) {
    const nextCustom = current.customPacks.filter((p) => p.id !== packId);
    await saveBundledPacksCustomizations({
      removedIds: current.removedIds,
      customPacks: nextCustom,
    });
    await db.customPackAssets.delete(packId).catch(() => {});
  } else {
    await saveBundledPacksCustomizations({
      removedIds: [...current.removedIds, packId],
      customPacks: current.customPacks,
    });
  }

  if (options?.clearDbEntries && targetPack) {
    const installedMap = await getInstalledBundledPacksMap();
    const status = installedMap[packId];
    const candidateImportIds = new Set<string>([`bundle-${packId}`]);
    if (status?.importId) candidateImportIds.add(status.importId);
    if (targetPack.sourceType === 'cloud-v2') {
      candidateImportIds.add(`pack-${targetPack.languageId}-cloud`);
      candidateImportIds.add(`pack-${targetPack.languageId}-bundled`);
      candidateImportIds.add(`pack-${targetPack.languageId}-starter`);
    }

    for (const impId of candidateImportIds) {
      await deleteImportInBatches(impId).catch(() => {});
    }

    // Refresh installedPacks state for that language
    const remainingImports = await db.imports
      .where('languageCode')
      .equals(targetPack.languageId)
      .toArray();
    const remainingEntries = await db.jmdictEntries
      .where('languageCode')
      .equals(targetPack.languageId)
      .filter((r) => !r.kinds?.includes('sentences'))
      .count();

    if (remainingImports.length === 0 && remainingEntries === 0) {
      await db.packForms.where('languageCode').equals(targetPack.languageId).delete();
      await db.installedPacks.delete(targetPack.languageId);
    } else {
      const existingInstalled = await db.installedPacks.get(targetPack.languageId);
      if (existingInstalled) {
        await db.installedPacks.put({
          ...existingInstalled,
          entryCount: remainingEntries,
          updatedAt: Date.now(),
        });
      }
    }

    await clearBundledPackInstalledStatus(packId);
  }

  await logEvent('developer_pack_removed', {
    packId,
    clearDbEntries: Boolean(options?.clearDbEntries),
  });
}

export async function restoreDefaultBundledPacks(): Promise<void> {
  await saveBundledPacksCustomizations({ removedIds: [], customPacks: [] });
  try {
    await db.customPackAssets.clear();
  } catch {
    // Ignore DB errors
  }
  await logEvent('developer_packs_restored_defaults', {});
}

// ---------------------------------------------------------------------------
// Unified Sequential Importer Pipeline Across All 5 Pack Categories
// ---------------------------------------------------------------------------

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Installation cancelled', 'AbortError');
  }
}

export async function readTextFromFileOrBytes(
  data: Uint8Array | ArrayBuffer | string,
  fileName = ''
): Promise<{ text: string; sizeBytes: number }> {
  if (typeof data === 'string') {
    return {
      text: stripUtf8Bom(data),
      sizeBytes: new TextEncoder().encode(data).byteLength,
    };
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const lower = fileName.toLowerCase().split('?')[0];
  let text = '';
  if (lower.endsWith('.gz') || isGzipBytes(bytes)) {
    text = await decompressGzipBytesToText(bytes);
  } else {
    text = new TextDecoder('utf-8').decode(bytes);
  }
  return {
    text: stripUtf8Bom(text),
    sizeBytes: bytes.byteLength,
  };
}

async function loadBundledPackText(
  pack: BundledPackDefinition,
  signal?: AbortSignal
): Promise<{ text: string; sizeBytes: number; fileName: string }> {
  if (pack.sourceType === 'custom-asset') {
    const asset = await db.customPackAssets.get(pack.customAssetId || pack.id);
    if (!asset) {
      throw new Error(`Custom pack asset "${pack.title}" not found in IndexedDB.`);
    }
    const { text, sizeBytes } = await readTextFromFileOrBytes(asset.data, asset.fileName);
    return { text, sizeBytes: asset.sizeBytes || sizeBytes, fileName: asset.fileName };
  }

  if (!pack.url) {
    throw new Error(`Pack "${pack.title}" has no source URL.`);
  }

  const res = await fetch(pack.url, { signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while fetching ${pack.url}`);
  }
  const buf = await res.arrayBuffer();
  const fileName = pack.url.split('?')[0].split('/').pop() || `${pack.id}.${pack.fileFormat || 'json'}`;
  const { text, sizeBytes } = await readTextFromFileOrBytes(buf, fileName);
  return { text, sizeBytes, fileName };
}

function extractWordsFromSentence(sentence: string): string[] {
  const out = new Set<string>();
  // Latin/Cyrillic/Hangul words (>= 2 chars)
  const wordMatches = sentence.match(/[\p{L}\p{N}]{2,}/gu) || [];
  for (const w of wordMatches) {
    out.add(w);
    out.add(w.toLowerCase());
  }
  // CJK contiguous runs & bigrams/single kanji for CJK sentence linking
  const cjkRuns = sentence.match(/[\u4e00-\u9faf\u3400-\u4dbf]+/g) || [];
  for (const run of cjkRuns) {
    out.add(run);
    for (let len = Math.min(4, run.length); len >= 1; len--) {
      for (let i = 0; i + len <= run.length; i++) {
        out.add(run.slice(i, i + len));
      }
    }
  }
  return Array.from(out).slice(0, 40);
}

async function importDictBundle(
  pack: BundledPackDefinition,
  text: string,
  sizeBytes: number,
  fileName: string,
  signal?: AbortSignal
): Promise<number> {
  const importId = `bundle-${pack.id}`;
  const trimmed = text.trim();
  const isJson =
    pack.fileFormat === 'json' ||
    pack.fileFormat === 'json.gz' ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');

  let rawEntries: Array<{
    id?: string;
    word: string;
    traditionalForm?: string;
    readings?: string[];
    meanings: string[];
    partsOfSpeech?: string[];
    level?: string;
    frequencyRank?: number;
  }> = [];
  let formsMap: Record<string, string[]> = {};

  if (isJson) {
    const parsed = JSON.parse(trimmed);
    const extracted = extractRawPackDataFromParsedJson(parsed);
    rawEntries = extracted.entries;
    formsMap = extracted.forms;
  } else {
    const table = parseDelimitedPackTable(trimmed, fileName, pack.category);
    const dictRows: ParsedDictCsvRow[] = extractDictRowsFromTable(table, pack.columnMapping);
    rawEntries = dictRows.map((r) => ({
      word: r.word,
      readings: r.readings,
      meanings: r.meanings,
      partsOfSpeech: r.partsOfSpeech,
      level: r.level,
      frequencyRank: r.frequencyRank,
    }));
  }

  if (rawEntries.length === 0) {
    throw new Error(`No valid vocabulary entries found in "${pack.title}".`);
  }

  // Delete any prior version of this exact bundle import first so updates are clean
  await deleteImportInBatches(importId).catch(() => {});

  const items = normalizeEntriesToJmdictItems(pack.languageId, importId, rawEntries, 'dictionary');
  const BATCH_SIZE = 1500;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    throwIfAborted(signal);
    await db.jmdictEntries.bulkPut(items.slice(i, i + BATCH_SIZE));
  }

  if (Object.keys(formsMap).length > 0) {
    await storePackFormsInBatches(pack.languageId, formsMap, signal);
  }

  if (pack.languageId === 'zh') {
    invalidateMandarinLexiconCache();
  }

  const now = Date.now();
  const impRecord: ImportRecord = {
    importId,
    languageCode: pack.languageId,
    kind: 'dictionary',
    fileName,
    fileSize: sizeBytes,
    fingerprint: `${importId}-${items.length}-${sizeBytes}`,
    date: now,
    entryCount: items.length,
    version: pack.version || '1.0.0',
    description: pack.title,
  };
  await db.imports.put(impRecord);

  const totalCount = await db.jmdictEntries
    .where('languageCode')
    .equals(pack.languageId)
    .filter((r) => !r.kinds?.includes('sentences'))
    .count();

  const existingPack = await db.installedPacks.get(pack.languageId);
  await db.installedPacks.put({
    languageId: pack.languageId,
    version: existingPack?.version || pack.version || '1.0.0',
    installedAt: existingPack?.installedAt || now,
    updatedAt: now,
    source: existingPack?.source || 'bundled',
    entryCount: totalCount,
    sizeBytes: (existingPack?.sizeBytes || 0) + sizeBytes,
    subpacks: Array.from(new Set([...(existingPack?.subpacks || []), pack.id])),
    manifestUrl: existingPack?.manifestUrl,
  });

  await ensureDefaultDeck(pack.languageId);
  await markBundledPackInstalled({
    packId: pack.id,
    languageId: pack.languageId,
    category: pack.category,
    importId,
    installedAt: now,
    entryCount: items.length,
    version: pack.version || '1.0.0',
  });

  return items.length;
}

async function importKanjiLevelsBundle(
  pack: BundledPackDefinition,
  text: string,
  sizeBytes: number,
  fileName: string,
  signal?: AbortSignal
): Promise<number> {
  const importId = `bundle-${pack.id}`;
  const trimmed = text.trim();
  let rows: ParsedKanjiCsvRow[] = [];

  if (
    pack.fileFormat === 'json' ||
    pack.fileFormat === 'json.gz' ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[')
  ) {
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.entries)
      ? parsed.entries
      : Array.isArray(parsed?.kanji)
      ? parsed.kanji
      : Array.isArray(parsed?.items)
      ? parsed.items
      : null;

    if (arr) {
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const ch = String(item.character ?? item.kanji ?? item.char ?? '').normalize('NFC').trim();
        if (!ch) continue;
        const rawLvl = String(item.jlptLevel ?? item.jlpt ?? item.level ?? '').trim();
        const lvlMatch = rawLvl.match(/([1-5])/);
        const jlptLevel = lvlMatch ? `N${lvlMatch[1]}` : 'No level';
        const meanings = Array.isArray(item.meanings)
          ? item.meanings.map((m: any) => String(m).trim()).filter(Boolean)
          : typeof item.meaning === 'string'
          ? item.meaning.split(/[;|,]+/).map((s: string) => s.trim()).filter(Boolean)
          : [];
        const onReadings = Array.isArray(item.readings?.on)
          ? item.readings.on
          : Array.isArray(item.onyomi)
          ? item.onyomi
          : typeof item.onyomi === 'string'
          ? item.onyomi.split(/[,;/\s]+/).filter(Boolean)
          : [];
        const kunReadings = Array.isArray(item.readings?.kun)
          ? item.readings.kun
          : Array.isArray(item.kunyomi)
          ? item.kunyomi
          : typeof item.kunyomi === 'string'
          ? item.kunyomi.split(/[,;/\s]+/).filter(Boolean)
          : [];
        rows.push({
          character: ch,
          jlptLevel,
          meanings,
          onReadings,
          kunReadings,
          strokeCount: typeof item.strokeCount === 'number' ? item.strokeCount : undefined,
        });
      }
    } else if (parsed && typeof parsed === 'object') {
      for (const [ch, val] of Object.entries(parsed)) {
        const clean = ch.normalize('NFC').trim();
        if (!clean) continue;
        const lvlMatch = String(val).match(/([1-5])/);
        rows.push({
          character: clean,
          jlptLevel: lvlMatch ? `N${lvlMatch[1]}` : 'No level',
          meanings: [],
          onReadings: [],
          kunReadings: [],
        });
      }
    }
  } else {
    const table = parseDelimitedPackTable(trimmed, fileName, 'kanji-levels');
    rows = extractKanjiRowsFromTable(table, fileName, pack.columnMapping);
  }

  if (rows.length === 0) {
    throw new Error(`No valid kanji entries found in "${pack.title}".`);
  }

  await deleteImportInBatches(importId).catch(() => {});

  const existingEntries = await db.kanjiEntries.toArray();
  const existingMap = new Map<string, KanjiEntryItem>();
  for (const e of existingEntries) existingMap.set(e.character, e);

  const batchMap = new Map<string, KanjiEntryItem>();
  for (const r of rows) {
    const existing = batchMap.get(r.character) || existingMap.get(r.character);
    if (existing) {
      if (isEasierLevel(r.jlptLevel, existing.jlptLevel)) {
        existing.jlptLevel = r.jlptLevel;
      }
      if (r.onReadings.length > 0) {
        existing.readings = {
          ...existing.readings,
          on: Array.from(new Set([...(existing.readings?.on || []), ...r.onReadings])),
        };
      }
      if (r.kunReadings.length > 0) {
        existing.readings = {
          ...existing.readings,
          kun: Array.from(new Set([...(existing.readings?.kun || []), ...r.kunReadings])),
        };
      }
      if (r.meanings.length > 0) {
        existing.meanings = Array.from(new Set([...(existing.meanings || []), ...r.meanings]));
      }
      if (r.strokeCount && !existing.strokeCount) {
        existing.strokeCount = r.strokeCount;
      }
      existing.importIds = Array.from(new Set([...(existing.importIds || []), importId]));
      existing.updatedAt = Date.now();
      batchMap.set(r.character, existing);
    } else {
      batchMap.set(r.character, {
        character: r.character,
        jlptLevel: r.jlptLevel,
        readings:
          r.onReadings.length > 0 || r.kunReadings.length > 0
            ? { on: r.onReadings, kun: r.kunReadings }
            : undefined,
        meanings: r.meanings.length > 0 ? r.meanings : undefined,
        strokeCount: r.strokeCount,
        importIds: [importId],
        updatedAt: Date.now(),
      });
    }
  }

  const allKanji = Array.from(batchMap.values());
  const BATCH_SIZE = 500;
  for (let i = 0; i < allKanji.length; i += BATCH_SIZE) {
    throwIfAborted(signal);
    await db.kanjiEntries.bulkPut(allKanji.slice(i, i + BATCH_SIZE));
  }

  const now = Date.now();
  await db.imports.put({
    importId,
    languageCode: pack.languageId,
    kind: 'kanji-levels',
    fileName,
    fileSize: sizeBytes,
    fingerprint: `${importId}-${allKanji.length}-${sizeBytes}`,
    date: now,
    entryCount: allKanji.length,
    version: pack.version || '1.0.0',
    description: pack.title,
  });

  await markBundledPackInstalled({
    packId: pack.id,
    languageId: pack.languageId,
    category: pack.category,
    importId,
    installedAt: now,
    entryCount: allKanji.length,
    version: pack.version || '1.0.0',
  });

  return allKanji.length;
}

async function importExamplesBundle(
  pack: BundledPackDefinition,
  text: string,
  sizeBytes: number,
  fileName: string,
  signal?: AbortSignal
): Promise<number> {
  const importId = `bundle-${pack.id}`;
  const trimmed = text.trim();
  let rows: ParsedExampleCsvRow[] = [];

  if (
    pack.fileFormat === 'json' ||
    pack.fileFormat === 'json.gz' ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[')
  ) {
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.examples)
      ? parsed.examples
      : Array.isArray(parsed?.entries)
      ? parsed.entries
      : Array.isArray(parsed?.sentences)
      ? parsed.sentences
      : Array.isArray(parsed?.items)
      ? parsed.items
      : null;

    if (arr) {
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const sentence = String(
          item.sentence ?? item.original ?? item.target ?? item.text ?? item.japanese ?? ''
        ).trim();
        const translation = String(
          item.translation ?? item.english ?? item.meaning ?? item.gloss ?? ''
        ).trim();
        if (!sentence || !translation) continue;
        rows.push({
          sentence,
          translation,
          word: item.word ? String(item.word).trim() : item.lemma ? String(item.lemma).trim() : undefined,
          reading: item.reading ? String(item.reading).trim() : undefined,
        });
      }
    }
  } else {
    const table = parseDelimitedPackTable(trimmed, fileName, 'examples');
    rows = extractExampleRowsFromTable(table, pack.columnMapping);
  }

  if (rows.length === 0) {
    throw new Error(`No valid example sentence pairs found in "${pack.title}".`);
  }

  await deleteImportInBatches(importId).catch(() => {});

  const items: JmdictEntryItem[] = rows.map((r, idx) => {
    const linkedForms = new Set<string>();
    if (r.word) {
      for (const w of r.word.split(/[;|]+/).map((s) => s.trim()).filter(Boolean)) {
        linkedForms.add(w);
        linkedForms.add(w.toLowerCase());
      }
    } else {
      for (const w of extractWordsFromSentence(r.sentence)) {
        linkedForms.add(w);
      }
    }

    return {
      id: `sent-${pack.languageId}-${pack.id}-${idx}`,
      languageCode: pack.languageId,
      forms: Array.from(linkedForms),
      kanji: [{ text: r.sentence }],
      kana: r.reading ? [{ text: r.reading }] : [],
      senses: [{ partsOfSpeech: ['Example'], glosses: [r.translation] }],
      primaryWord: r.sentence,
      primaryReading: r.reading || '',
      priorityScore: 50,
      priorityTags: [],
      importIds: [importId],
      kinds: ['sentences'],
    };
  });

  const BATCH_SIZE = 1500;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    throwIfAborted(signal);
    await db.jmdictEntries.bulkPut(items.slice(i, i + BATCH_SIZE));
  }

  const now = Date.now();
  await db.imports.put({
    importId,
    languageCode: pack.languageId,
    kind: 'sentences',
    fileName,
    fileSize: sizeBytes,
    fingerprint: `${importId}-${items.length}-${sizeBytes}`,
    date: now,
    entryCount: items.length,
    version: pack.version || '1.0.0',
    description: pack.title,
  });

  await markBundledPackInstalled({
    packId: pack.id,
    languageId: pack.languageId,
    category: pack.category,
    importId,
    installedAt: now,
    entryCount: items.length,
    version: pack.version || '1.0.0',
  });

  return items.length;
}

async function importFrequencyBundle(
  pack: BundledPackDefinition,
  text: string,
  sizeBytes: number,
  fileName: string,
  signal?: AbortSignal
): Promise<number> {
  const importId = `bundle-${pack.id}`;
  const trimmed = text.trim();
  let rows: ParsedFrequencyCsvRow[] = [];

  if (
    pack.fileFormat === 'json' ||
    pack.fileFormat === 'json.gz' ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[')
  ) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      rows = parsed
        .map((it: any, idx: number) => {
          if (typeof it === 'string') return { word: it.trim(), rank: idx + 1 };
          if (!it || typeof it !== 'object') return null;
          const word = String(it.word ?? it.term ?? it.expression ?? it.w ?? '').trim();
          const rank = Number(it.rank ?? it.frequencyRank ?? it.frequency ?? it.f ?? idx + 1);
          return word && Number.isFinite(rank) && rank > 0 ? { word, rank: Math.round(rank) } : null;
        })
        .filter((x): x is ParsedFrequencyCsvRow => Boolean(x));
    } else if (parsed && typeof parsed === 'object') {
      const arr = parsed.entries || parsed.words || parsed.items;
      if (Array.isArray(arr)) {
        rows = arr
          .map((it: any, idx: number) => {
            if (typeof it === 'string') return { word: it.trim(), rank: idx + 1 };
            const word = String(it?.word ?? it?.term ?? it?.expression ?? it?.w ?? '').trim();
            const rank = Number(it?.rank ?? it?.frequencyRank ?? it?.frequency ?? it?.f ?? idx + 1);
            return word && Number.isFinite(rank) && rank > 0 ? { word, rank: Math.round(rank) } : null;
          })
          .filter((x): x is ParsedFrequencyCsvRow => Boolean(x));
      } else {
        rows = Object.entries(parsed)
          .map(([w, r]) => ({ word: w.trim(), rank: Number(r) }))
          .filter((x) => Boolean(x.word) && Number.isFinite(x.rank) && x.rank > 0);
      }
    }
  } else {
    const table = parseDelimitedPackTable(trimmed, fileName, 'frequency');
    rows = extractFrequencyRowsFromTable(table, pack.columnMapping);
  }

  if (rows.length === 0) {
    throw new Error(`No valid frequency entries found in "${pack.title}".`);
  }

  await deleteImportInBatches(importId).catch(() => {});

  const langEntries = await db.jmdictEntries
    .where('languageCode')
    .equals(pack.languageId)
    .filter((r) => !r.kinds?.includes('sentences'))
    .toArray();

  const entriesByForm = new Map<string, JmdictEntryItem[]>();
  for (const entry of langEntries) {
    for (const f of entry.forms || []) {
      const key = f.toLowerCase();
      const list = entriesByForm.get(key) || [];
      list.push(entry);
      entriesByForm.set(key, list);
    }
  }

  const updatedEntries = new Map<string, JmdictEntryItem>();
  for (const item of rows) {
    throwIfAborted(signal);
    const matches =
      entriesByForm.get(item.word.toLowerCase()) ||
      entriesByForm.get(item.word) ||
      [];
    const band = deriveBandFromRank(item.rank);
    const levelGuess = mapFrequencyRankToLevel(pack.languageId, item.rank);

    for (const entry of matches) {
      entry.importIds = Array.from(new Set([...(entry.importIds || []), importId]));
      entry.kinds = Array.from(new Set([...(entry.kinds || []), 'frequency']));
      entry.overlayData = entry.overlayData || {};
      entry.overlayData[importId] = { frequencyRank: item.rank };
      entry.frequencyRank = item.rank;
      entry.frequencyBand = band;
      if (!entry.jlptLevel && levelGuess) {
        entry.jlptLevel = levelGuess;
      }
      entry.priorityScore = Math.max(
        entry.priorityScore || 0,
        Math.max(10, 10000 - Math.min(9990, item.rank))
      );
      updatedEntries.set(entry.id, entry);
    }
  }

  const toSave = Array.from(updatedEntries.values());
  const BATCH_SIZE = 1500;
  for (let i = 0; i < toSave.length; i += BATCH_SIZE) {
    throwIfAborted(signal);
    await db.jmdictEntries.bulkPut(toSave.slice(i, i + BATCH_SIZE));
  }

  const now = Date.now();
  await db.imports.put({
    importId,
    languageCode: pack.languageId,
    kind: 'frequency',
    fileName,
    fileSize: sizeBytes,
    fingerprint: `${importId}-${rows.length}-${sizeBytes}`,
    date: now,
    entryCount: rows.length,
    version: pack.version || '1.0.0',
    description: pack.title,
  });

  await markBundledPackInstalled({
    packId: pack.id,
    languageId: pack.languageId,
    category: pack.category,
    importId,
    installedAt: now,
    entryCount: rows.length,
    version: pack.version || '1.0.0',
  });

  return rows.length;
}

export async function installSingleBundledPack(
  pack: BundledPackDefinition,
  options?: {
    signal?: AbortSignal;
    mode?: 'auto' | 'cloud-strict' | 'starter';
    onSubProgress?: (percent: number, stage: string) => void;
  }
): Promise<{ entryCount: number; source: string }> {
  const signal = options?.signal;
  throwIfAborted(signal);

  if (pack.sourceType === 'cloud-v2' && pack.category === 'core-dict') {
    const res = await installLanguagePack(pack.languageId, {
      signal,
      mode: options?.mode ?? 'auto',
      onProgress: (prog) => {
        options?.onSubProgress?.(prog.percent, prog.stage);
      },
    });
    await markBundledPackInstalled({
      packId: pack.id,
      languageId: pack.languageId,
      category: pack.category,
      importId: `pack-${pack.languageId}-${res.source}`,
      installedAt: Date.now(),
      entryCount: res.entryCount,
      version: res.record.version,
    });
    return { entryCount: res.entryCount, source: res.source };
  }

  options?.onSubProgress?.(20, `Loading ${pack.title}...`);
  const { text, sizeBytes, fileName } = await loadBundledPackText(pack, signal);
  throwIfAborted(signal);
  options?.onSubProgress?.(60, `Indexing ${pack.title}...`);

  let count = 0;
  if (pack.category === 'core-dict' || pack.category === 'common-dict') {
    count = await importDictBundle(pack, text, sizeBytes, fileName, signal);
  } else if (pack.category === 'kanji-levels') {
    count = await importKanjiLevelsBundle(pack, text, sizeBytes, fileName, signal);
  } else if (pack.category === 'examples') {
    count = await importExamplesBundle(pack, text, sizeBytes, fileName, signal);
  } else if (pack.category === 'frequency') {
    count = await importFrequencyBundle(pack, text, sizeBytes, fileName, signal);
  }

  options?.onSubProgress?.(100, `Installed ${pack.title}`);
  return { entryCount: count, source: pack.sourceType };
}

export async function installAllIncludedPacksForLanguage(
  languageId: string,
  options?: {
    signal?: AbortSignal;
    mode?: 'auto' | 'cloud-strict' | 'starter';
    globOverride?: Record<string, string>;
    skipRemoteManifest?: boolean;
    onProgress?: (progress: LanguageBundleInstallProgress) => void;
  }
): Promise<{ installedCount: number; totalEntries: number; packIds: string[] }> {
  const signal = options?.signal;
  throwIfAborted(signal);

  const includedPacks = await getIncludedPacksForLanguage(languageId, {
    globOverride: options?.globOverride,
    skipRemoteManifest: options?.skipRemoteManifest,
  });

  if (includedPacks.length === 0) {
    // Ensure at least default starter / deck exists if developer excluded everything
    await ensureDefaultDeck(languageId);
    return { installedCount: 0, totalEntries: 0, packIds: [] };
  }

  const total = includedPacks.length;
  let totalEntries = 0;
  const installedIds: string[] = [];

  for (let i = 0; i < total; i++) {
    throwIfAborted(signal);
    const pack = includedPacks[i];
    const stepBase = (i / total) * 100;
    const stepSpan = 100 / total;

    options?.onProgress?.({
      languageId,
      currentIndex: i + 1,
      totalCount: total,
      currentPack: pack,
      percent: Math.max(3, Math.round(stepBase + 2)),
      stage: `Installing ${i + 1} of ${total}: ${pack.title}...`,
    });

    const res = await installSingleBundledPack(pack, {
      signal,
      mode: options?.mode ?? 'auto',
      onSubProgress: (subPct) => {
        const overall = Math.min(99, Math.round(stepBase + (subPct / 100) * stepSpan));
        options?.onProgress?.({
          languageId,
          currentIndex: i + 1,
          totalCount: total,
          currentPack: pack,
          percent: Math.max(3, overall),
          stage: `Installing ${i + 1} of ${total}: ${pack.title}...`,
        });
      },
    });

    totalEntries += res.entryCount;
    installedIds.push(pack.id);
  }

  // Ensure installedPacks record exists even if core-dict was removed by developer and only sub-packs were installed
  const existingInstalled = await db.installedPacks.get(languageId);
  if (!existingInstalled) {
    const dbCount = await db.jmdictEntries
      .where('languageCode')
      .equals(languageId)
      .filter((r) => !r.kinds?.includes('sentences'))
      .count();
    await db.installedPacks.put({
      languageId,
      version: '1.0.0',
      installedAt: Date.now(),
      updatedAt: Date.now(),
      source: 'bundled',
      entryCount: dbCount || totalEntries,
      sizeBytes: 0,
      subpacks: installedIds,
    });
    await ensureDefaultDeck(languageId);
  } else {
    await db.installedPacks.put({
      ...existingInstalled,
      updatedAt: Date.now(),
      subpacks: Array.from(new Set([...(existingInstalled.subpacks || []), ...installedIds])),
    });
  }

  await logEvent('language_bundle_installed', {
    languageId,
    packCount: installedIds.length,
    totalEntries,
  });

  return {
    installedCount: installedIds.length,
    totalEntries,
    packIds: installedIds,
  };
}

export async function installAllAvailableLanguagePacks(options?: {
  languageIds?: string[];
  signal?: AbortSignal;
  mode?: 'auto' | 'cloud-strict' | 'starter';
  globOverride?: Record<string, string>;
  skipRemoteManifest?: boolean;
  onProgress?: (progress: AllLanguagesBundleInstallProgress) => void;
}): Promise<{
  languagesInstalled: string[];
  totalPacksInstalled: number;
  totalEntries: number;
}> {
  const signal = options?.signal;
  throwIfAborted(signal);

  const { packs } = await getEffectiveBundledPacks({
    globOverride: options?.globOverride,
    skipRemoteManifest: options?.skipRemoteManifest,
  });

  const targetLangs = options?.languageIds
    ? options.languageIds
    : getAllLanguagePacks()
        .map((p) => p.id)
        .filter((id) => packs.some((bp) => bp.languageId === id));

  let totalPacksInstalled = 0;
  let totalEntries = 0;
  const languagesInstalled: string[] = [];

  for (let i = 0; i < targetLangs.length; i++) {
    throwIfAborted(signal);
    const langId = targetLangs[i];
    const langName = getLanguagePack(langId).name;

    const res = await installAllIncludedPacksForLanguage(langId, {
      signal,
      mode: options?.mode ?? 'auto',
      globOverride: options?.globOverride,
      skipRemoteManifest: options?.skipRemoteManifest,
      onProgress: (lp) => {
        const overallPct = Math.min(
          99,
          Math.round(((i + lp.percent / 100) / Math.max(1, targetLangs.length)) * 100)
        );
        options?.onProgress?.({
          languageIndex: i + 1,
          totalLanguages: targetLangs.length,
          currentLanguageId: langId,
          languageProgress: lp,
          overallPercent: Math.max(2, overallPct),
          stage: `[${i + 1}/${targetLangs.length} ${langName}] ${lp.stage}`,
        });
      },
    });

    languagesInstalled.push(langId);
    totalPacksInstalled += res.installedCount;
    totalEntries += res.totalEntries;
  }

  return {
    languagesInstalled,
    totalPacksInstalled,
    totalEntries,
  };
}

export async function previewCsvOrTsvForDeveloper(
  category: BundledPackCategory,
  rawText: string,
  fileName: string
) {
  const table = parseDelimitedPackTable(rawText, fileName, category);
  const detection = detectCategoryColumnMapping(category, table);
  return {
    table,
    detection,
  };
}

export { isAbortError };
