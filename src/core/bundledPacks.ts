import {
  db,
  deleteImportInBatches,
  type CustomPackAssetItem,
  type ImportKind,
  type ImportRecord,
  type JmdictEntryItem,
  type KanjiEntryItem,
} from '../db/db';
import { ensureDefaultDeck } from '../db/cards';
import { getAllLanguagePacks, getLanguagePack } from '../packs/registry';
import { deriveBandFromRank } from '../packs/japanese/jmdictFrequency';
import {
  inferLevelFromFileName,
  isEasierLevel,
  normalizeJlptLevel,
  parseKanjiListTable,
  resolveRowJlptLevel,
  SINGLE_KANJI_REGEX,
} from '../packs/japanese/kanjiListParser';
import { invalidateMandarinLexiconCache } from '../packs/multilingualPack';
import { mapFrequencyRankToLevel } from './languagePack';
import { logEvent } from './eventLogger';
import {
  DEFAULT_PACK_MANIFEST_URL,
  extractRawPackDataFromParsedJson,
  fetchCloudPackManifest,
  getPackManifestUrl,
  installLanguagePack,
  isAbortError,
  normalizeEntriesToJmdictItems,
  normalizeRawPackItem,
  resolveManifestPackUrl,
  storePackFormsInBatches,
  type RawPackEntryInput,
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
  type ParsedExampleCsvRow,
  type ParsedFrequencyCsvRow,
  type ParsedKanjiCsvRow,
} from './packCsvParser';
import {
  PackLoadError,
  detectAndDecodePackContent,
  formatPackError,
  type ContentDetectionResult,
} from './packFormatDetector';

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
  required?: boolean;
  origin: 'default' | 'auto-discovered' | 'custom';
  customAssetId?: string;
  columnMapping?: Record<string, number>;
}

export function isBundledPackRequired(pack: BundledPackDefinition): boolean {
  return pack.required !== undefined ? pack.required : pack.category === 'core-dict';
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
  status?: 'installed' | 'covered';
  coveredBy?: string;
  isFullDictionary?: boolean;
  warning?: string;
}

export interface BundledPackFailure {
  pack: BundledPackDefinition;
  languageId: string;
  error: string;
  httpStatus?: number;
  detectedFormat?: string;
  required: boolean;
}

export interface BundledPackSkipped {
  pack: BundledPackDefinition;
  reason: 'covered' | 'manual-duplicate';
  details: string;
  existingImportId?: string;
}

export type LanguageInstallStatus = 'installed' | 'partial' | 'not-installed';

export interface LanguageBundleInstallResult {
  languageId: string;
  installedCount: number;
  totalPacks: number;
  totalEntries: number;
  packIds: string[];
  failedPacks: BundledPackFailure[];
  skippedPacks: BundledPackSkipped[];
  warnings: string[];
  languageStatus: LanguageInstallStatus;
}

export interface AllLanguagesBundleInstallResult {
  languagesInstalled: string[];
  partialLanguages: string[];
  totalPacksInstalled: number;
  totalPacksAttempted: number;
  totalEntries: number;
  failedPacks: BundledPackFailure[];
  skippedPacks: BundledPackSkipped[];
  warnings: string[];
  summaryText: string;
}

export interface PackCheckRow {
  packId: string;
  packTitle: string;
  languageId: string;
  category: BundledPackCategory;
  filePath: string;
  status: 'ok' | 'warning' | 'error';
  detectedFormat: string;
  rowsFound: number;
  problem: string;
  httpStatus?: number;
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
  const res = await detectAndDecodePackContent(data, {
    packTitle: fileName || 'Pack file',
    filePath: fileName || 'upload',
  }).catch(async (err) => {
    // Allow raw text decoding in preview helper even if format check flags empty
    if (typeof data === 'string') {
      return {
        text: stripUtf8Bom(data),
        sizeBytes: new TextEncoder().encode(data).byteLength,
      };
    }
    throw err;
  });
  return {
    text: res.text,
    sizeBytes: res.sizeBytes,
  };
}

function resolvePackFilePath(pack: BundledPackDefinition): string {
  return (pack.url || `indexeddb://customPackAssets/${pack.customAssetId || pack.id}`).trim();
}

function getFileNameFromPath(filePath: string, pack: BundledPackDefinition): string {
  const base = filePath.split('?')[0].split('/').pop();
  return base || `${pack.id}.${pack.fileFormat || 'json'}`;
}

async function fetchAndDetectPackContent(
  pack: BundledPackDefinition,
  signal?: AbortSignal,
  overrideUrl?: string
): Promise<{
  detected: ContentDetectionResult;
  fileName: string;
  filePath: string;
  httpStatus?: number;
}> {
  if (pack.sourceType === 'custom-asset') {
    const asset = await db.customPackAssets.get(pack.customAssetId || pack.id);
    const filePath = asset?.fileName || resolvePackFilePath(pack);
    if (!asset) {
      throw new PackLoadError({
        packTitle: pack.title,
        filePath,
        reason: 'Custom pack asset not found in IndexedDB.',
      });
    }
    const detected = await detectAndDecodePackContent(asset.data, {
      packTitle: pack.title,
      filePath,
      declaredFormat: pack.fileFormat,
    });
    return { detected, fileName: asset.fileName, filePath };
  }

  const targetUrl = (overrideUrl || pack.url || '').trim();
  if (!targetUrl) {
    throw new PackLoadError({
      packTitle: pack.title,
      filePath: '(no URL)',
      reason: 'Pack has no source URL.',
    });
  }

  let res: Response;
  try {
    res = await fetch(targetUrl, { signal });
  } catch (err: any) {
    if (isAbortError(err)) throw err;
    throw new PackLoadError({
      packTitle: pack.title,
      filePath: targetUrl,
      reason: err?.message || 'Network error while fetching pack.',
    });
  }

  if (!res.ok) {
    throw new PackLoadError({
      packTitle: pack.title,
      filePath: targetUrl,
      httpStatus: res.status,
      reason:
        res.status === 404
          ? `File not found on server: ${targetUrl}`
          : `HTTP ${res.status} ${res.statusText || 'request failed'}`,
    });
  }

  const buf = await res.arrayBuffer();
  const fileName = getFileNameFromPath(targetUrl, pack);
  const detected = await detectAndDecodePackContent(buf, {
    packTitle: pack.title,
    filePath: targetUrl,
    httpStatus: res.status,
    declaredFormat: pack.fileFormat,
  });

  return {
    detected,
    fileName,
    filePath: targetUrl,
    httpStatus: res.status,
  };
}

// ---------------------------------------------------------------------------
// Content-Based Format-to-Parser Category Router (shared by importers & Pack check)
// ---------------------------------------------------------------------------

function extractKanjiRowFromJsonItem(
  item: Record<string, any>,
  inferredLevel: string | null
): ParsedKanjiCsvRow | null {
  const ch = String(item.character ?? item.kanji ?? item.char ?? item.utf ?? '')
    .normalize('NFC')
    .trim();
  if (!ch || !SINGLE_KANJI_REGEX.test(ch)) return null;

  const rawLvl = item.jlptLevel ?? item.jlpt ?? item.level ?? item.jlpt_level ?? '';
  const jlptLevel = resolveRowJlptLevel(rawLvl, inferredLevel);

  let meanings: string[] = [];
  if (Array.isArray(item.meanings)) {
    meanings = item.meanings.map((m: any) => String(m).trim()).filter(Boolean);
  } else if (typeof item.meaning === 'string') {
    meanings = item.meaning
      .split(/[;|,]+/)
      .map((s: string) => s.trim())
      .filter(Boolean);
  } else if (typeof item.description === 'string') {
    const m = item.description.match(/\bmeans\s+([^.]+)\./i);
    if (m && m[1]) {
      meanings = m[1]
        .split(/[,;]+/)
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
  }

  const onReadings: string[] = Array.isArray(item.readings?.on)
    ? item.readings.on.map((v: any) => String(v).trim()).filter(Boolean)
    : Array.isArray(item.onyomi)
    ? item.onyomi.map((v: any) => String(v).trim()).filter(Boolean)
    : typeof item.onyomi === 'string'
    ? item.onyomi.split(/[,;/、\s]+/).filter(Boolean)
    : [];

  const kunReadings: string[] = Array.isArray(item.readings?.kun)
    ? item.readings.kun.map((v: any) => String(v).trim()).filter(Boolean)
    : Array.isArray(item.kunyomi)
    ? item.kunyomi.map((v: any) => String(v).trim()).filter(Boolean)
    : typeof item.kunyomi === 'string'
    ? item.kunyomi.split(/[,;/、\s]+/).filter(Boolean)
    : [];

  const rawStroke = item.strokeCount ?? item.strokes ?? item.stroke_count;
  const parsedStroke =
    typeof rawStroke === 'number'
      ? rawStroke
      : typeof rawStroke === 'string'
      ? parseInt(rawStroke.replace(/\D/g, ''), 10)
      : NaN;
  const strokeCount = Number.isFinite(parsedStroke) && parsedStroke > 0 ? parsedStroke : undefined;

  return {
    character: ch,
    jlptLevel,
    meanings,
    onReadings,
    kunReadings,
    strokeCount,
  };
}

function extractExamplesFromJsonItem(item: unknown, limit?: number): ParsedExampleCsvRow[] {
  if (!item || typeof item !== 'object') return [];
  const obj = item as Record<string, any>;
  const out: ParsedExampleCsvRow[] = [];

  // 1. jmdict-simplified word object containing sense[].examples[]
  if (Array.isArray(obj.sense)) {
    const kanjiHeadwords = Array.isArray(obj.kanji)
      ? obj.kanji.map((k: any) => String(k?.text || '').trim()).filter(Boolean)
      : [];
    const kanaReadings = Array.isArray(obj.kana)
      ? obj.kana.map((k: any) => String(k?.text || '').trim()).filter(Boolean)
      : [];

    for (const s of obj.sense) {
      if (!s || !Array.isArray(s.examples)) continue;
      for (const ex of s.examples) {
        if (!ex || typeof ex !== 'object') continue;
        const sentences = Array.isArray(ex.sentences) ? ex.sentences : [];
        let targetSent = '';
        let engSent = '';
        for (const sent of sentences) {
          if (!sent || typeof sent !== 'object') continue;
          const lang = String(sent.lang || '').toLowerCase();
          const txt = String(sent.text || '').trim();
          if (!txt) continue;
          if (lang === 'eng' || lang === 'en') {
            if (!engSent) engSent = txt;
          } else if (!targetSent) {
            targetSent = txt;
          }
        }
        if (!targetSent || !engSent) continue;

        const linkedWords = Array.from(
          new Set([
            ...(ex.text ? [String(ex.text).trim()] : []),
            ...kanjiHeadwords,
            ...kanaReadings,
          ].filter(Boolean))
        );

        out.push({
          sentence: targetSent,
          translation: engSent,
          word: linkedWords.length > 0 ? linkedWords.join('|') : undefined,
          reading: kanaReadings[0] || undefined,
        });
        if (limit !== undefined && out.length >= limit) return out;
      }
    }
    return out;
  }

  // 2. Direct Tatoeba / sentence-pair object
  let sentence = String(
    obj.sentence ?? obj.original ?? obj.target ?? obj.japanese ?? obj.jpn ?? ''
  ).trim();
  let translation = String(
    obj.translation ?? obj.english ?? obj.meaning ?? obj.gloss ?? obj.eng ?? ''
  ).trim();

  if ((!sentence || !translation) && Array.isArray(obj.sentences)) {
    for (const sent of obj.sentences) {
      if (!sent || typeof sent !== 'object') continue;
      const lang = String(sent.lang || '').toLowerCase();
      const txt = String(sent.text || '').trim();
      if (!txt) continue;
      if ((lang === 'eng' || lang === 'en') && !translation) translation = txt;
      else if (!sentence) sentence = txt;
    }
  }
  if (!sentence && typeof obj.text === 'string' && translation) {
    sentence = obj.text.trim();
  }

  if (sentence && translation) {
    const word = obj.word
      ? String(obj.word).trim()
      : obj.lemma
      ? String(obj.lemma).trim()
      : undefined;
    const reading = obj.reading ? String(obj.reading).trim() : undefined;
    out.push({ sentence, translation, word, reading });
  }

  return out;
}

function extractFrequencyRowFromJsonItem(
  it: unknown,
  fallbackRank: number
): ParsedFrequencyCsvRow | null {
  if (typeof it === 'string') {
    const w = it.trim();
    return w ? { word: w, rank: fallbackRank } : null;
  }
  if (Array.isArray(it) && it.length >= 1) {
    const word = String(it[0] ?? '').trim();
    const rank = Number(it[1] ?? fallbackRank);
    return word && Number.isFinite(rank) && rank > 0
      ? { word, rank: Math.round(rank) }
      : null;
  }
  if (!it || typeof it !== 'object') return null;
  const obj = it as Record<string, any>;
  const word = String(obj.word ?? obj.term ?? obj.expression ?? obj.w ?? '').trim();
  const form = obj.form ?? obj.reading ? String(obj.form ?? obj.reading).trim() : undefined;
  const rank = Number(obj.rank ?? obj.frequencyRank ?? obj.frequency ?? obj.f ?? fallbackRank);
  return word && Number.isFinite(rank) && rank > 0
    ? { word, rank: Math.round(rank), form: form && form !== word ? form : undefined }
    : null;
}

type ParsedCategoryPayload =
  | { kind: 'dict'; entries: RawPackEntryInput[]; forms: Record<string, string[]> }
  | { kind: 'kanji'; rows: ParsedKanjiCsvRow[] }
  | { kind: 'examples'; rows: ParsedExampleCsvRow[] }
  | { kind: 'frequency'; rows: ParsedFrequencyCsvRow[] };

function parseJsonLines<T>(
  text: string,
  pack: BundledPackDefinition,
  filePath: string,
  httpStatus: number | undefined,
  detectedLabel: string,
  maxRows: number | undefined,
  mapper: (item: unknown, index: number) => T | T[] | null
): T[] {
  const out: T[] = [];
  const lines = text.split(/\r?\n/);
  let lineNum = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    lineNum++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err: any) {
      throw new PackLoadError({
        packTitle: pack.title,
        filePath,
        httpStatus,
        detectedFormat: detectedLabel,
        reason: `Invalid JSONL on line ${lineNum}: ${err?.message || 'parse error'}`,
      });
    }

    const res = mapper(parsed, out.length);
    if (Array.isArray(res)) {
      for (const item of res) {
        out.push(item);
        if (maxRows !== undefined && out.length >= maxRows) return out;
      }
    } else if (res) {
      out.push(res);
      if (maxRows !== undefined && out.length >= maxRows) return out;
    }
  }
  return out;
}

function parsePackContentForCategory(opts: {
  pack: BundledPackDefinition;
  detected: ContentDetectionResult;
  fileName: string;
  filePath: string;
  httpStatus?: number;
  maxRows?: number;
}): ParsedCategoryPayload {
  const { pack, detected, fileName, filePath, httpStatus, maxRows } = opts;
  const fmt = detected.format;

  if (fmt !== 'json' && fmt !== 'jsonl' && fmt !== 'csv' && fmt !== 'tsv') {
    throw new PackLoadError({
      packTitle: pack.title,
      filePath,
      httpStatus,
      detectedFormat: detected.detectedLabel,
      reason: `Unsupported pack content format (${detected.detectedLabel}).`,
    });
  }

  const parseJsonSafe = (): unknown => {
    try {
      return JSON.parse(detected.text);
    } catch (err: any) {
      throw new PackLoadError({
        packTitle: pack.title,
        filePath,
        httpStatus,
        detectedFormat: detected.detectedLabel,
        reason: err?.message || 'Invalid JSON syntax.',
      });
    }
  };

  // 1. Dictionary categories (core-dict / common-dict)
  if (pack.category === 'core-dict' || pack.category === 'common-dict') {
    if (fmt === 'json') {
      const parsed = parseJsonSafe();
      try {
        const extracted = extractRawPackDataFromParsedJson(parsed, maxRows);
        return { kind: 'dict', entries: extracted.entries, forms: extracted.forms };
      } catch (err: any) {
        throw new PackLoadError({
          packTitle: pack.title,
          filePath,
          httpStatus,
          detectedFormat: detected.detectedLabel,
          reason: err?.message || 'Unexpected dictionary JSON structure.',
        });
      }
    }
    if (fmt === 'jsonl') {
      const entries = parseJsonLines(
        detected.text,
        pack,
        filePath,
        httpStatus,
        detected.detectedLabel,
        maxRows,
        (item) => normalizeRawPackItem(item, 'dictionary')
      );
      return { kind: 'dict', entries, forms: {} };
    }
    // csv / tsv
    const table = parseDelimitedPackTable(detected.text, fileName, pack.category, maxRows);
    const dictRows = extractDictRowsFromTable(table, pack.columnMapping);
    return {
      kind: 'dict',
      entries: dictRows.map((r) => ({
        word: r.word,
        readings: r.readings,
        meanings: r.meanings,
        partsOfSpeech: r.partsOfSpeech,
        level: r.level,
        frequencyRank: r.frequencyRank,
      })),
      forms: {},
    };
  }

  // 2. Kanji & JLPT Levels
  if (pack.category === 'kanji-levels') {
    const inferredLevel = inferLevelFromFileName(fileName);
    if (fmt === 'json') {
      const parsed = parseJsonSafe() as any;
      const rows: ParsedKanjiCsvRow[] = [];
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.entries)
        ? parsed.entries
        : Array.isArray(parsed?.kanji)
        ? parsed.kanji
        : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.words)
        ? parsed.words
        : Array.isArray(parsed?.data)
        ? parsed.data
        : null;

      if (arr) {
        for (const item of arr) {
          if (typeof item === 'string') {
            const ch = item.normalize('NFC').trim();
            if (ch && SINGLE_KANJI_REGEX.test(ch)) {
              rows.push({
                character: ch,
                jlptLevel: inferredLevel || 'No level',
                meanings: [],
                onReadings: [],
                kunReadings: [],
              });
            }
          } else if (item && typeof item === 'object') {
            const r = extractKanjiRowFromJsonItem(item, inferredLevel);
            if (r) rows.push(r);
          }
          if (maxRows !== undefined && rows.length >= maxRows) break;
        }
      } else if (parsed && typeof parsed === 'object') {
        for (const [ch, val] of Object.entries(parsed)) {
          const clean = ch.normalize('NFC').trim();
          if (!clean || !SINGLE_KANJI_REGEX.test(clean)) continue;
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            const r = extractKanjiRowFromJsonItem({ character: clean, ...val }, inferredLevel);
            if (r) rows.push(r);
          } else {
            rows.push({
              character: clean,
              jlptLevel: resolveRowJlptLevel(val, inferredLevel),
              meanings: [],
              onReadings: [],
              kunReadings: [],
            });
          }
          if (maxRows !== undefined && rows.length >= maxRows) break;
        }
      }
      return { kind: 'kanji', rows };
    }

    if (fmt === 'jsonl') {
      const rows = parseJsonLines(
        detected.text,
        pack,
        filePath,
        httpStatus,
        detected.detectedLabel,
        maxRows,
        (item) =>
          item && typeof item === 'object'
            ? extractKanjiRowFromJsonItem(item as Record<string, any>, inferredLevel)
            : null
      );
      return { kind: 'kanji', rows };
    }

    // csv / tsv
    const table = parseDelimitedPackTable(detected.text, fileName, 'kanji-levels', maxRows);
    let rows = extractKanjiRowsFromTable(table, fileName, pack.columnMapping);
    if (rows.length === 0 && !pack.columnMapping) {
      // Fallback to kanjiListParser heuristic auto-detection for unconventional column headers
      const kTable = parseKanjiListTable(detected.text, fileName);
      const km = kTable.detectedMapping;
      rows = extractKanjiRowsFromTable(
        {
          delimiter: kTable.format === 'tsv' ? '\t' : ',',
          headers: kTable.headers,
          hasHeaderRow: kTable.hasHeaderRow,
          rows: maxRows !== undefined ? kTable.rows.slice(0, maxRows) : kTable.rows,
        },
        fileName,
        {
          character: km.charCol,
          level: km.levelCol,
          reading: km.readingCol,
          onyomi: km.onCol,
          kunyomi: km.kunCol,
          meaning: km.meaningCol,
          strokes: km.strokeCol,
        }
      );
    }
    return { kind: 'kanji', rows };
  }

  // 3. Examples
  if (pack.category === 'examples') {
    if (fmt === 'json') {
      const parsed = parseJsonSafe() as any;
      const rows: ParsedExampleCsvRow[] = [];
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
        : Array.isArray(parsed?.words)
        ? parsed.words
        : null;

      if (arr) {
        for (const item of arr) {
          const remaining = maxRows !== undefined ? maxRows - rows.length : undefined;
          if (remaining !== undefined && remaining <= 0) break;
          const extracted = extractExamplesFromJsonItem(item, remaining);
          for (const ex of extracted) {
            rows.push(ex);
            if (maxRows !== undefined && rows.length >= maxRows) break;
          }
          if (maxRows !== undefined && rows.length >= maxRows) break;
        }
      }
      return { kind: 'examples', rows };
    }

    if (fmt === 'jsonl') {
      const rows = parseJsonLines(
        detected.text,
        pack,
        filePath,
        httpStatus,
        detected.detectedLabel,
        maxRows,
        (item) => extractExamplesFromJsonItem(item)
      );
      return { kind: 'examples', rows };
    }

    // csv / tsv
    const table = parseDelimitedPackTable(detected.text, fileName, 'examples', maxRows);
    const rows = extractExampleRowsFromTable(table, pack.columnMapping);
    return { kind: 'examples', rows };
  }

  // 4. Frequency
  if (fmt === 'json') {
    const parsed = parseJsonSafe() as any;
    const rows: ParsedFrequencyCsvRow[] = [];
    if (Array.isArray(parsed)) {
      for (let i = 0; i < parsed.length; i++) {
        const row = extractFrequencyRowFromJsonItem(parsed[i], i + 1);
        if (row) rows.push(row);
        if (maxRows !== undefined && rows.length >= maxRows) break;
      }
    } else if (parsed && typeof parsed === 'object') {
      const arr = parsed.entries || parsed.words || parsed.items;
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i++) {
          const row = extractFrequencyRowFromJsonItem(arr[i], i + 1);
          if (row) rows.push(row);
          if (maxRows !== undefined && rows.length >= maxRows) break;
        }
      } else {
        for (const [w, r] of Object.entries(parsed)) {
          const rankNum = Number(r);
          if (w.trim() && Number.isFinite(rankNum) && rankNum > 0) {
            rows.push({ word: w.trim(), rank: Math.round(rankNum) });
            if (maxRows !== undefined && rows.length >= maxRows) break;
          }
        }
      }
    }
    return { kind: 'frequency', rows };
  }

  if (fmt === 'jsonl') {
    const rows = parseJsonLines(
      detected.text,
      pack,
      filePath,
      httpStatus,
      detected.detectedLabel,
      maxRows,
      (item, idx) => extractFrequencyRowFromJsonItem(item, idx + 1)
    );
    return { kind: 'frequency', rows };
  }

  // csv / tsv
  const table = parseDelimitedPackTable(detected.text, fileName, 'frequency', maxRows);
  const rows = extractFrequencyRowsFromTable(table, pack.columnMapping);
  return { kind: 'frequency', rows };
}

function getPayloadRowCount(payload: ParsedCategoryPayload): number {
  if (payload.kind === 'dict') return payload.entries.length;
  return payload.rows.length;
}

// ---------------------------------------------------------------------------
// Category Importers
// ---------------------------------------------------------------------------

async function importDictBundle(
  pack: BundledPackDefinition,
  detected: ContentDetectionResult,
  fileName: string,
  filePath: string,
  httpStatus: number | undefined,
  signal?: AbortSignal
): Promise<number> {
  const importId = `bundle-${pack.id}`;
  const parsed = parsePackContentForCategory({
    pack,
    detected,
    fileName,
    filePath,
    httpStatus,
  });
  if (parsed.kind !== 'dict' || parsed.entries.length === 0) {
    throw new PackLoadError({
      packTitle: pack.title,
      filePath,
      httpStatus,
      detectedFormat: detected.detectedLabel,
      reason: 'No valid vocabulary entries found.',
    });
  }

  await deleteImportInBatches(importId).catch(() => {});

  const items = normalizeEntriesToJmdictItems(pack.languageId, importId, parsed.entries, 'dictionary');
  const BATCH_SIZE = 1500;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    throwIfAborted(signal);
    await db.jmdictEntries.bulkPut(items.slice(i, i + BATCH_SIZE));
  }

  if (Object.keys(parsed.forms).length > 0) {
    await storePackFormsInBatches(pack.languageId, parsed.forms, signal);
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
    fileSize: detected.sizeBytes,
    fingerprint: `${importId}-${items.length}-${detected.sizeBytes}`,
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
    status: existingPack?.status === 'partial' && pack.category !== 'core-dict' ? 'partial' : 'installed',
    entryCount: totalCount,
    sizeBytes: (existingPack?.sizeBytes || 0) + detected.sizeBytes,
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
    status: 'installed',
    isFullDictionary: pack.category === 'core-dict',
    warning: detected.mismatchWarning,
  });

  return items.length;
}

async function importKanjiLevelsBundle(
  pack: BundledPackDefinition,
  detected: ContentDetectionResult,
  fileName: string,
  filePath: string,
  httpStatus: number | undefined,
  signal?: AbortSignal
): Promise<number> {
  const importId = `bundle-${pack.id}`;
  const parsed = parsePackContentForCategory({
    pack,
    detected,
    fileName,
    filePath,
    httpStatus,
  });
  if (parsed.kind !== 'kanji' || parsed.rows.length === 0) {
    throw new PackLoadError({
      packTitle: pack.title,
      filePath,
      httpStatus,
      detectedFormat: detected.detectedLabel,
      reason: 'No valid kanji entries found.',
    });
  }

  await deleteImportInBatches(importId).catch(() => {});

  const existingEntries = await db.kanjiEntries.toArray();
  const existingMap = new Map<string, KanjiEntryItem>();
  for (const e of existingEntries) existingMap.set(e.character, e);

  const batchMap = new Map<string, KanjiEntryItem>();
  for (const r of parsed.rows) {
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
    fileSize: detected.sizeBytes,
    fingerprint: `${importId}-${allKanji.length}-${detected.sizeBytes}`,
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
    status: 'installed',
    warning: detected.mismatchWarning,
  });

  return allKanji.length;
}

function extractWordsFromSentence(sentence: string, languageId = 'en'): string[] {
  const out = new Set<string>();
  const trimmed = sentence.trim();
  if (!trimmed) return [];

  if (typeof Intl !== 'undefined' && typeof (Intl as any).Segmenter === 'function') {
    try {
      const seg = new (Intl as any).Segmenter(languageId, { granularity: 'word' });
      for (const part of seg.segment(trimmed)) {
        if (part.isWordLike) {
          const w = String(part.segment).trim();
          if (w) {
            out.add(w);
            out.add(w.toLowerCase());
          }
        }
      }
      if (out.size > 0) return Array.from(out);
    } catch {
      // Fallback to regex tokenization
    }
  }

  const matches = trimmed.match(/[\p{L}\p{N}ー'-]+/gu) || [];
  for (const m of matches) {
    out.add(m);
    out.add(m.toLowerCase());
  }
  return Array.from(out);
}

async function importExamplesBundle(
  pack: BundledPackDefinition,
  detected: ContentDetectionResult,
  fileName: string,
  filePath: string,
  httpStatus: number | undefined,
  signal?: AbortSignal
): Promise<number> {
  const importId = `bundle-${pack.id}`;
  const parsed = parsePackContentForCategory({
    pack,
    detected,
    fileName,
    filePath,
    httpStatus,
  });
  if (parsed.kind !== 'examples' || parsed.rows.length === 0) {
    throw new PackLoadError({
      packTitle: pack.title,
      filePath,
      httpStatus,
      detectedFormat: detected.detectedLabel,
      reason: 'No valid example sentence pairs found.',
    });
  }

  await deleteImportInBatches(importId).catch(() => {});

  const items: JmdictEntryItem[] = parsed.rows.map((r, idx) => {
    const linkedForms = new Set<string>();
    if (r.word) {
      for (const w of r.word.split(/[;|]+/).map((s) => s.trim()).filter(Boolean)) {
        linkedForms.add(w);
        linkedForms.add(w.toLowerCase());
      }
    } else {
      for (const w of extractWordsFromSentence(r.sentence, pack.languageId)) {
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
    fileSize: detected.sizeBytes,
    fingerprint: `${importId}-${items.length}-${detected.sizeBytes}`,
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
    status: 'installed',
    warning: detected.mismatchWarning,
  });

  return items.length;
}

async function importFrequencyBundle(
  pack: BundledPackDefinition,
  detected: ContentDetectionResult,
  fileName: string,
  filePath: string,
  httpStatus: number | undefined,
  signal?: AbortSignal
): Promise<number> {
  const importId = `bundle-${pack.id}`;
  const parsed = parsePackContentForCategory({
    pack,
    detected,
    fileName,
    filePath,
    httpStatus,
  });
  if (parsed.kind !== 'frequency' || parsed.rows.length === 0) {
    throw new PackLoadError({
      packTitle: pack.title,
      filePath,
      httpStatus,
      detectedFormat: detected.detectedLabel,
      reason: 'No valid frequency entries found.',
    });
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
  for (const item of parsed.rows) {
    throwIfAborted(signal);
    const matches =
      entriesByForm.get(item.word.toLowerCase()) ||
      entriesByForm.get(item.word) ||
      (item.form ? entriesByForm.get(item.form.toLowerCase()) || entriesByForm.get(item.form) : undefined) ||
      [];
    if (matches.length === 0) continue;

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
    fileSize: detected.sizeBytes,
    fingerprint: `${importId}-${parsed.rows.length}-${detected.sizeBytes}`,
    date: now,
    entryCount: parsed.rows.length,
    version: pack.version || '1.0.0',
    description: pack.title,
  });

  await markBundledPackInstalled({
    packId: pack.id,
    languageId: pack.languageId,
    category: pack.category,
    importId,
    installedAt: now,
    entryCount: parsed.rows.length,
    version: pack.version || '1.0.0',
    status: 'installed',
    warning: detected.mismatchWarning,
  });

  return parsed.rows.length;
}

// ---------------------------------------------------------------------------
// Deduplication Helpers (Subset Coverage & Manual Import Protection)
// ---------------------------------------------------------------------------

function mapCategoryToImportKinds(category: BundledPackCategory): ImportKind[] {
  switch (category) {
    case 'core-dict':
    case 'common-dict':
      return ['dictionary'];
    case 'kanji-levels':
      return ['kanji-levels', 'kanji'];
    case 'examples':
      return ['sentences'];
    case 'frequency':
      return ['frequency'];
  }
}

function normalizeBasenameForCompare(fileName: string): string {
  return (fileName || '')
    .split('?')[0]
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/\.(gz|zip)$/i, '');
}

export async function isFullDictionaryInstalledForLanguage(
  languageId: string
): Promise<{ installed: boolean; coveredBy?: string }> {
  const installedBundles = await getInstalledBundledPacksMap();
  for (const status of Object.values(installedBundles)) {
    if (
      status.languageId === languageId &&
      status.category === 'core-dict' &&
      status.status !== 'covered' &&
      (status.isFullDictionary === true ||
        status.entryCount >= 5000 ||
        status.importId.endsWith('-cloud'))
    ) {
      return { installed: true, coveredBy: status.packId };
    }
  }

  const imports = await db.imports.where('languageCode').equals(languageId).toArray();
  for (const imp of imports) {
    if (imp.kind !== 'dictionary') continue;
    const isManualFull =
      !imp.importId.startsWith('bundle-') &&
      !imp.importId.startsWith('pack-') &&
      (imp.entryCount >= 5000 || /jmdict/i.test(imp.fileName));
    const isCloudFull =
      imp.importId === `pack-${languageId}-cloud` ||
      (imp.importId.startsWith('bundle-') &&
        !imp.importId.includes('common') &&
        imp.entryCount >= 5000);
    if (isManualFull || isCloudFull) {
      return { installed: true, coveredBy: imp.description || imp.fileName };
    }
  }

  return { installed: false };
}

export async function findManualDuplicateForPack(
  pack: BundledPackDefinition
): Promise<ImportRecord | null> {
  const imports = await db.imports.where('languageCode').equals(pack.languageId).toArray();
  const manualImports = imports.filter(
    (imp) => !imp.importId.startsWith('bundle-') && !imp.importId.startsWith('pack-')
  );
  if (manualImports.length === 0) return null;

  const packFile = normalizeBasenameForCompare(pack.url || pack.title);
  const packInferredLevel = inferLevelFromFileName(pack.url || pack.title);
  const validKinds = new Set<ImportKind>(mapCategoryToImportKinds(pack.category));

  for (const imp of manualImports) {
    if (imp.entryCount <= 0) continue;
    const impFile = normalizeBasenameForCompare(imp.fileName);
    if (packFile && impFile && impFile === packFile) {
      return imp;
    }

    if (!validKinds.has(imp.kind)) continue;

    if (pack.category === 'core-dict' || pack.category === 'common-dict') {
      return imp;
    }

    if (pack.category === 'kanji-levels') {
      const impInferredLevel = inferLevelFromFileName(imp.fileName);
      // Skip if manual import covers all JLPT levels (>=1000 kanji) or matches the same JLPT level
      if (imp.entryCount >= 1000 || !packInferredLevel || impInferredLevel === packInferredLevel) {
        return imp;
      }
      continue;
    }

    // examples / frequency
    if (imp.entryCount >= 100 || !impFile || !packFile) {
      return imp;
    }
  }

  return null;
}

export async function installSingleBundledPack(
  pack: BundledPackDefinition,
  options?: {
    signal?: AbortSignal;
    mode?: 'auto' | 'cloud-strict' | 'starter';
    overwriteManualImports?: boolean;
    onSubProgress?: (percent: number, stage: string) => void;
  }
): Promise<{
  entryCount: number;
  source: string;
  skipped?: BundledPackSkipped;
  warning?: string;
}> {
  const signal = options?.signal;
  throwIfAborted(signal);

  // Deduplication 1: Skip manual import duplicates unless user explicitly opted in
  if (!options?.overwriteManualImports) {
    const manualDup = await findManualDuplicateForPack(pack);
    if (manualDup) {
      const skipped: BundledPackSkipped = {
        pack,
        reason: 'manual-duplicate',
        details: `Skipped "${pack.title}": duplicates manual import "${manualDup.fileName}" (${manualDup.entryCount.toLocaleString()} entries).`,
        existingImportId: manualDup.importId,
      };
      options?.onSubProgress?.(100, `Skipped (manual import exists): ${pack.title}`);
      return { entryCount: 0, source: 'skipped-manual', skipped };
    }
  }

  // Deduplication 2: Skip subset common-dict if full dictionary is already installed
  if (pack.category === 'common-dict') {
    const fullCheck = await isFullDictionaryInstalledForLanguage(pack.languageId);
    if (fullCheck.installed) {
      await markBundledPackInstalled({
        packId: pack.id,
        languageId: pack.languageId,
        category: pack.category,
        importId: 'covered',
        installedAt: Date.now(),
        entryCount: 0,
        version: pack.version || '1.0.0',
        status: 'covered',
        coveredBy: fullCheck.coveredBy || 'Core Dictionary',
      });
      const skipped: BundledPackSkipped = {
        pack,
        reason: 'covered',
        details: `Covered by installed full dictionary (${fullCheck.coveredBy || 'Core Dictionary'}).`,
      };
      options?.onSubProgress?.(100, `Covered by full dictionary: ${pack.title}`);
      return { entryCount: 0, source: 'covered', skipped };
    }
  }

  if (pack.sourceType === 'cloud-v2' && pack.category === 'core-dict') {
    const res = await installLanguagePack(pack.languageId, {
      signal,
      mode: options?.mode ?? 'auto',
      onProgress: (prog) => {
        options?.onSubProgress?.(prog.percent, prog.stage);
      },
    });
    const isFullDict = res.source === 'cloud';
    await markBundledPackInstalled({
      packId: pack.id,
      languageId: pack.languageId,
      category: pack.category,
      importId: `pack-${pack.languageId}-${res.source}`,
      installedAt: Date.now(),
      entryCount: res.entryCount,
      version: res.record.version,
      status: 'installed',
      isFullDictionary: isFullDict,
    });
    return { entryCount: res.entryCount, source: res.source };
  }

  options?.onSubProgress?.(20, `Loading ${pack.title}...`);
  const { detected, fileName, filePath, httpStatus } = await fetchAndDetectPackContent(pack, signal);
  throwIfAborted(signal);
  options?.onSubProgress?.(60, `Indexing ${pack.title}...`);

  let count = 0;
  if (pack.category === 'core-dict' || pack.category === 'common-dict') {
    count = await importDictBundle(pack, detected, fileName, filePath, httpStatus, signal);
  } else if (pack.category === 'kanji-levels') {
    count = await importKanjiLevelsBundle(pack, detected, fileName, filePath, httpStatus, signal);
  } else if (pack.category === 'examples') {
    count = await importExamplesBundle(pack, detected, fileName, filePath, httpStatus, signal);
  } else if (pack.category === 'frequency') {
    count = await importFrequencyBundle(pack, detected, fileName, filePath, httpStatus, signal);
  }

  options?.onSubProgress?.(100, `Installed ${pack.title}`);
  return { entryCount: count, source: pack.sourceType, warning: detected.mismatchWarning };
}

export async function installAllIncludedPacksForLanguage(
  languageId: string,
  options?: {
    signal?: AbortSignal;
    mode?: 'auto' | 'cloud-strict' | 'starter';
    overwriteManualImports?: boolean;
    globOverride?: Record<string, string>;
    skipRemoteManifest?: boolean;
    onProgress?: (progress: LanguageBundleInstallProgress) => void;
  }
): Promise<LanguageBundleInstallResult> {
  const signal = options?.signal;
  throwIfAborted(signal);

  const includedPacks = await getIncludedPacksForLanguage(languageId, {
    globOverride: options?.globOverride,
    skipRemoteManifest: options?.skipRemoteManifest,
  });

  if (includedPacks.length === 0) {
    await ensureDefaultDeck(languageId);
    return {
      languageId,
      installedCount: 0,
      totalPacks: 0,
      totalEntries: 0,
      packIds: [],
      failedPacks: [],
      skippedPacks: [],
      warnings: [],
      languageStatus: 'not-installed',
    };
  }

  const total = includedPacks.length;
  let totalEntries = 0;
  const installedIds: string[] = [];
  const failedPacks: BundledPackFailure[] = [];
  const skippedPacks: BundledPackSkipped[] = [];
  const warnings: string[] = [];

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

    try {
      const res = await installSingleBundledPack(pack, {
        signal,
        mode: options?.mode ?? 'auto',
        overwriteManualImports: options?.overwriteManualImports,
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

      if (res.skipped) {
        skippedPacks.push(res.skipped);
      } else {
        totalEntries += res.entryCount;
        installedIds.push(pack.id);
      }
      if (res.warning) {
        warnings.push(res.warning);
      }
    } catch (err: any) {
      if (isAbortError(err)) throw err;
      const errMsg =
        err instanceof PackLoadError
          ? err.message
          : formatPackError({
              packTitle: pack.title,
              filePath: resolvePackFilePath(pack),
              reason: err?.message || String(err),
            });
      failedPacks.push({
        pack,
        languageId,
        error: errMsg,
        httpStatus: err instanceof PackLoadError ? err.httpStatus : undefined,
        detectedFormat: err instanceof PackLoadError ? err.detectedFormat : undefined,
        required: isBundledPackRequired(pack),
      });
    }
  }

  // Evaluate required pack success: a language counts as installed only if its required packs succeeded
  const installedBundlesMap = await getInstalledBundledPacksMap();
  const requiredPacks = includedPacks.filter(isBundledPackRequired);
  const allRequiredSucceeded =
    requiredPacks.length === 0
      ? installedIds.length > 0 || skippedPacks.length > 0
      : requiredPacks.every(
          (rp) =>
            installedIds.includes(rp.id) ||
            Boolean(installedBundlesMap[rp.id]) ||
            skippedPacks.some((s) => s.pack.id === rp.id)
        );

  const anySucceededOrSkipped = installedIds.length > 0 || skippedPacks.length > 0;
  let languageStatus: LanguageInstallStatus = 'not-installed';
  if (allRequiredSucceeded && anySucceededOrSkipped) {
    languageStatus = 'installed';
  } else if (anySucceededOrSkipped || (await db.imports.where('languageCode').equals(languageId).count()) > 0) {
    languageStatus = 'partial';
  }

  if (languageStatus !== 'not-installed') {
    const existingInstalled = await db.installedPacks.get(languageId);
    const dbCount = await db.jmdictEntries
      .where('languageCode')
      .equals(languageId)
      .filter((r) => !r.kinds?.includes('sentences'))
      .count();
    await db.installedPacks.put({
      languageId,
      version: existingInstalled?.version || '1.0.0',
      installedAt: existingInstalled?.installedAt || Date.now(),
      updatedAt: Date.now(),
      source: existingInstalled?.source || 'bundled',
      status: languageStatus === 'installed' ? 'installed' : 'partial',
      entryCount: dbCount || totalEntries,
      sizeBytes: existingInstalled?.sizeBytes || 0,
      subpacks: Array.from(new Set([...(existingInstalled?.subpacks || []), ...installedIds])),
      manifestUrl: existingInstalled?.manifestUrl,
    });
    await ensureDefaultDeck(languageId);
  }

  await logEvent('language_bundle_installed', {
    languageId,
    packCount: installedIds.length,
    failedCount: failedPacks.length,
    skippedCount: skippedPacks.length,
    languageStatus,
    totalEntries,
  });

  return {
    languageId,
    installedCount: installedIds.length,
    totalPacks: total,
    totalEntries,
    packIds: installedIds,
    failedPacks,
    skippedPacks,
    warnings,
    languageStatus,
  };
}

export async function installAllAvailableLanguagePacks(options?: {
  languageIds?: string[];
  signal?: AbortSignal;
  mode?: 'auto' | 'cloud-strict' | 'starter';
  overwriteManualImports?: boolean;
  globOverride?: Record<string, string>;
  skipRemoteManifest?: boolean;
  onProgress?: (progress: AllLanguagesBundleInstallProgress) => void;
}): Promise<AllLanguagesBundleInstallResult> {
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
  let totalPacksAttempted = 0;
  let totalEntries = 0;
  const languagesInstalled: string[] = [];
  const partialLanguages: string[] = [];
  const failedPacks: BundledPackFailure[] = [];
  const skippedPacks: BundledPackSkipped[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < targetLangs.length; i++) {
    throwIfAborted(signal);
    const langId = targetLangs[i];
    const langName = getLanguagePack(langId).name;

    const res = await installAllIncludedPacksForLanguage(langId, {
      signal,
      mode: options?.mode ?? 'auto',
      overwriteManualImports: options?.overwriteManualImports,
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

    if (res.languageStatus === 'installed') {
      languagesInstalled.push(langId);
    } else if (res.languageStatus === 'partial') {
      partialLanguages.push(langId);
    }

    totalPacksInstalled += res.installedCount;
    totalPacksAttempted += res.totalPacks;
    totalEntries += res.totalEntries;
    failedPacks.push(...res.failedPacks);
    skippedPacks.push(...res.skippedPacks);
    warnings.push(...res.warnings);
  }

  const effectiveSuccessCount = totalPacksInstalled + skippedPacks.length;
  const summaryText =
    failedPacks.length > 0
      ? `${effectiveSuccessCount} of ${totalPacksAttempted} installed. ${failedPacks.length} failed: ${failedPacks
          .map((f) => f.pack.title)
          .join(', ')}`
      : `Installed ${totalPacksInstalled} of ${totalPacksAttempted} packs across ${languagesInstalled.length} languages (${totalEntries.toLocaleString()} entries).`;

  return {
    languagesInstalled,
    partialLanguages,
    totalPacksInstalled,
    totalPacksAttempted,
    totalEntries,
    failedPacks,
    skippedPacks,
    warnings,
    summaryText,
  };
}

export async function retryFailedBundledPacks(
  failures: BundledPackFailure[],
  options?: {
    signal?: AbortSignal;
    mode?: 'auto' | 'cloud-strict' | 'starter';
    overwriteManualImports?: boolean;
    onProgress?: (progress: { completed: number; total: number; currentTitle: string }) => void;
  }
): Promise<AllLanguagesBundleInstallResult> {
  const signal = options?.signal;
  throwIfAborted(signal);

  let totalPacksInstalled = 0;
  let totalEntries = 0;
  const failedPacks: BundledPackFailure[] = [];
  const skippedPacks: BundledPackSkipped[] = [];
  const warnings: string[] = [];
  const touchedLangs = new Set<string>();

  for (let i = 0; i < failures.length; i++) {
    throwIfAborted(signal);
    const { pack } = failures[i];
    touchedLangs.add(pack.languageId);
    options?.onProgress?.({
      completed: i,
      total: failures.length,
      currentTitle: pack.title,
    });

    try {
      const res = await installSingleBundledPack(pack, {
        signal,
        mode: options?.mode ?? 'auto',
        overwriteManualImports: options?.overwriteManualImports,
      });
      if (res.skipped) skippedPacks.push(res.skipped);
      else totalPacksInstalled++;
      totalEntries += res.entryCount;
      if (res.warning) warnings.push(res.warning);
    } catch (err: any) {
      if (isAbortError(err)) throw err;
      const errMsg =
        err instanceof PackLoadError
          ? err.message
          : formatPackError({
              packTitle: pack.title,
              filePath: resolvePackFilePath(pack),
              reason: err?.message || String(err),
            });
      failedPacks.push({
        pack,
        languageId: pack.languageId,
        error: errMsg,
        httpStatus: err instanceof PackLoadError ? err.httpStatus : undefined,
        detectedFormat: err instanceof PackLoadError ? err.detectedFormat : undefined,
        required: isBundledPackRequired(pack),
      });
    }
  }

  // Refresh installedPacks status for each touched language
  const installedBundlesMap = await getInstalledBundledPacksMap();
  const { packs: allActivePacks } = await getEffectiveBundledPacks({ skipRemoteManifest: true });
  const languagesInstalled: string[] = [];
  const partialLanguages: string[] = [];

  for (const langId of touchedLangs) {
    const langPacks = allActivePacks.filter((p) => p.languageId === langId);
    const requiredPacks = langPacks.filter(isBundledPackRequired);
    const allReqOk =
      requiredPacks.length === 0
        ? langPacks.some((p) => Boolean(installedBundlesMap[p.id]))
        : requiredPacks.every((rp) => Boolean(installedBundlesMap[rp.id]));
    const anyOk = langPacks.some((p) => Boolean(installedBundlesMap[p.id]));

    if (anyOk) {
      const existing = await db.installedPacks.get(langId);
      const dbCount = await db.jmdictEntries
        .where('languageCode')
        .equals(langId)
        .filter((r) => !r.kinds?.includes('sentences'))
        .count();
      const nextStatus: 'installed' | 'partial' = allReqOk ? 'installed' : 'partial';
      await db.installedPacks.put({
        languageId: langId,
        version: existing?.version || '1.0.0',
        installedAt: existing?.installedAt || Date.now(),
        updatedAt: Date.now(),
        source: existing?.source || 'bundled',
        status: nextStatus,
        entryCount: dbCount,
        sizeBytes: existing?.sizeBytes || 0,
        subpacks: existing?.subpacks || [],
        manifestUrl: existing?.manifestUrl,
      });
      await ensureDefaultDeck(langId);
      if (nextStatus === 'installed') languagesInstalled.push(langId);
      else partialLanguages.push(langId);
    }
  }

  const totalAttempted = failures.length;
  const effectiveOk = totalPacksInstalled + skippedPacks.length;
  const summaryText =
    failedPacks.length > 0
      ? `${effectiveOk} of ${totalAttempted} retried installed. ${failedPacks.length} failed: ${failedPacks
          .map((f) => f.pack.title)
          .join(', ')}`
      : `Retry succeeded: ${effectiveOk} of ${totalAttempted} packs installed (${totalEntries.toLocaleString()} entries).`;

  return {
    languagesInstalled,
    partialLanguages,
    totalPacksInstalled,
    totalPacksAttempted: totalAttempted,
    totalEntries,
    failedPacks,
    skippedPacks,
    warnings,
    summaryText,
  };
}

export async function runBundledPacksCheck(
  packs: BundledPackDefinition[],
  options?: {
    maxRows?: number;
    signal?: AbortSignal;
    onProgress?: (checked: number, total: number) => void;
  }
): Promise<PackCheckRow[]> {
  const maxRows = options?.maxRows ?? 100;
  const signal = options?.signal;
  const results: PackCheckRow[] = [];

  let cloudManifest: Awaited<ReturnType<typeof fetchCloudPackManifest>> = null;
  let manifestUrl = DEFAULT_PACK_MANIFEST_URL;
  if (packs.some((p) => p.sourceType === 'cloud-v2')) {
    manifestUrl = await getPackManifestUrl();
    cloudManifest = await fetchCloudPackManifest(manifestUrl, signal).catch(() => null);
  }

  for (let i = 0; i < packs.length; i++) {
    throwIfAborted(signal);
    const pack = packs[i];
    options?.onProgress?.(i, packs.length);

    let overrideUrl: string | undefined;
    if (pack.sourceType === 'cloud-v2') {
      const mItem = cloudManifest?.packs?.[pack.languageId];
      overrideUrl = resolveManifestPackUrl(mItem, manifestUrl) || pack.url;
    }

    const filePath = overrideUrl || resolvePackFilePath(pack);

    try {
      const { detected, fileName, filePath: resolvedPath, httpStatus } = await fetchAndDetectPackContent(
        pack,
        signal,
        overrideUrl
      );

      const parsed = parsePackContentForCategory({
        pack,
        detected,
        fileName,
        filePath: resolvedPath,
        httpStatus,
        maxRows,
      });

      const rowsFound = getPayloadRowCount(parsed);
      if (rowsFound === 0) {
        results.push({
          packId: pack.id,
          packTitle: pack.title,
          languageId: pack.languageId,
          category: pack.category,
          filePath: resolvedPath,
          status: 'error',
          detectedFormat: detected.detectedLabel,
          rowsFound: 0,
          httpStatus,
          problem: formatPackError({
            packTitle: pack.title,
            filePath: resolvedPath,
            httpStatus,
            detectedFormat: detected.detectedLabel,
            reason: `No valid ${BUNDLED_PACK_CATEGORY_LABELS[pack.category].toLowerCase()} rows found.`,
          }),
        });
      } else if (detected.mismatchWarning) {
        results.push({
          packId: pack.id,
          packTitle: pack.title,
          languageId: pack.languageId,
          category: pack.category,
          filePath: resolvedPath,
          status: 'warning',
          detectedFormat: detected.detectedLabel,
          rowsFound,
          httpStatus,
          problem: detected.mismatchWarning,
        });
      } else {
        results.push({
          packId: pack.id,
          packTitle: pack.title,
          languageId: pack.languageId,
          category: pack.category,
          filePath: resolvedPath,
          status: 'ok',
          detectedFormat: detected.detectedLabel,
          rowsFound,
          httpStatus,
          problem: '',
        });
      }
    } catch (err: any) {
      if (isAbortError(err)) throw err;
      results.push({
        packId: pack.id,
        packTitle: pack.title,
        languageId: pack.languageId,
        category: pack.category,
        filePath,
        status: 'error',
        detectedFormat: err instanceof PackLoadError && err.detectedFormat ? err.detectedFormat : 'Unknown',
        rowsFound: 0,
        httpStatus: err instanceof PackLoadError ? err.httpStatus : undefined,
        problem: err?.message || String(err),
      });
    }
  }

  options?.onProgress?.(packs.length, packs.length);
  return results;
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
