import { pinyin } from 'pinyin-pro';
import {
  mapFrequencyRankToLevel,
  type DictionaryEntry,
  type DifficultyLevelSystem,
  type FuriganaSegment,
  type GrammarPoint,
  type LanguagePack,
  type PackAssetManifestItem,
  type Token,
} from '../core/languagePack';
import { db, type JmdictEntryItem } from '../db/db';
import { deriveFrequencyInfo } from './japanese/jmdictFrequency';
import { STARTER_LEXICONS, type StarterLexiconEntry } from './starterData';

export const CEFR_LEVEL_SYSTEM: DifficultyLevelSystem = {
  id: 'cefr',
  name: 'CEFR',
  levels: [
    { code: 'A1', label: 'A1 (Breakthrough)', color: 'emerald', rankOrder: 1 },
    { code: 'A2', label: 'A2 (Waystage)', color: 'sky', rankOrder: 2 },
    { code: 'B1', label: 'B1 (Threshold)', color: 'amber', rankOrder: 3 },
    { code: 'B2', label: 'B2 (Vantage)', color: 'indigo', rankOrder: 4 },
    { code: 'C1', label: 'C1 (Effective)', color: 'purple', rankOrder: 5 },
    { code: 'C2', label: 'C2 (Mastery)', color: 'rose', rankOrder: 6 },
  ],
  defaultLevel: 'A1',
};

export const TOPIK_LEVEL_SYSTEM: DifficultyLevelSystem = {
  id: 'topik',
  name: 'TOPIK',
  levels: [
    { code: 'TOPIK 1', label: 'TOPIK 1 (Beginner)', color: 'emerald', rankOrder: 1 },
    { code: 'TOPIK 2', label: 'TOPIK 2 (Elementary)', color: 'sky', rankOrder: 2 },
    { code: 'TOPIK 3', label: 'TOPIK 3 (Intermediate I)', color: 'amber', rankOrder: 3 },
    { code: 'TOPIK 4', label: 'TOPIK 4 (Intermediate II)', color: 'indigo', rankOrder: 4 },
    { code: 'TOPIK 5', label: 'TOPIK 5 (Advanced I)', color: 'purple', rankOrder: 5 },
    { code: 'TOPIK 6', label: 'TOPIK 6 (Advanced II)', color: 'rose', rankOrder: 6 },
  ],
  defaultLevel: 'TOPIK 1',
};

export const HSK_LEVEL_SYSTEM: DifficultyLevelSystem = {
  id: 'hsk',
  name: 'HSK',
  levels: [
    { code: 'HSK 1', label: 'HSK 1 (Foundations)', color: 'emerald', rankOrder: 1 },
    { code: 'HSK 2', label: 'HSK 2 (Elementary)', color: 'sky', rankOrder: 2 },
    { code: 'HSK 3', label: 'HSK 3 (Intermediate)', color: 'amber', rankOrder: 3 },
    { code: 'HSK 4', label: 'HSK 4 (Upper Intermediate)', color: 'indigo', rankOrder: 4 },
    { code: 'HSK 5', label: 'HSK 5 (Advanced)', color: 'purple', rankOrder: 5 },
    { code: 'HSK 6', label: 'HSK 6 (Proficient)', color: 'rose', rankOrder: 6 },
  ],
  defaultLevel: 'HSK 1',
};

const HANZI_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * Generates per-character tone-marked Pinyin ruby segments for Mandarin text using `pinyin-pro`.
 */
export function buildMandarinPinyinSegments(text: string): {
  reading: string;
  furiganaSegments?: FuriganaSegment[];
} {
  if (!text || !HANZI_REGEX.test(text)) {
    return { reading: '' };
  }

  const chars = Array.from(text);
  let pinyinArray: string[] = [];
  try {
    pinyinArray = pinyin(text, { toneType: 'symbol', type: 'array', nonZh: 'consecutive' }) as string[];
  } catch {
    pinyinArray = [];
  }

  // When nonZh: 'consecutive' collapses multi-char ASCII spans, fall back per-char if array length mismatches
  const useWholeArray = pinyinArray.length === chars.length;

  const segments: FuriganaSegment[] = [];
  const readingParts: string[] = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (HANZI_REGEX.test(ch)) {
      let py = useWholeArray ? pinyinArray[i] : '';
      if (!py) {
        try {
          py = String(pinyin(ch, { toneType: 'symbol' }) || '').trim();
        } catch {
          py = '';
        }
      }
      if (py && py !== ch) {
        segments.push({ text: ch, ruby: py });
        readingParts.push(py);
      } else {
        segments.push({ text: ch });
      }
    } else {
      const last = segments[segments.length - 1];
      if (last && !last.ruby) {
        last.text += ch;
      } else {
        segments.push({ text: ch });
      }
    }
  }

  return {
    reading: readingParts.join(' '),
    furiganaSegments: segments.some((s) => Boolean(s.ruby)) ? segments : undefined,
  };
}

const FR_ELISION_RE = /^(l|d|qu|j|c|s|n|m|t|jusqu|lorsqu|puisqu|quoiqu)['’](.+)$/i;
const IT_ELISION_RE = /^(dell|all|dall|nell|sull|coll|un|l|d|c|s|n|m|t|gl)['’](.+)$/i;

function splitElisionSegment(
  langId: string,
  segment: string,
  startIndex: number
): Array<{ surface: string; startIndex: number; endIndex: number; isElisionPrefix?: boolean }> {
  const re = langId === 'fr' ? FR_ELISION_RE : langId === 'it' ? IT_ELISION_RE : null;
  if (!re) {
    return [{ surface: segment, startIndex, endIndex: startIndex + segment.length }];
  }

  const m = re.exec(segment);
  if (!m || !m[2]) {
    return [{ surface: segment, startIndex, endIndex: startIndex + segment.length }];
  }

  const prefixWithAposLen = segment.length - m[2].length;
  const prefix = segment.slice(0, prefixWithAposLen);
  const rest = segment.slice(prefixWithAposLen);

  return [
    {
      surface: prefix,
      startIndex,
      endIndex: startIndex + prefix.length,
      isElisionPrefix: true,
    },
    {
      surface: rest,
      startIndex: startIndex + prefix.length,
      endIndex: startIndex + segment.length,
    },
  ];
}

function segmentTextFallback(text: string): Array<{ segment: string; index: number; isWordLike: boolean }> {
  const out: Array<{ segment: string; index: number; isWordLike: boolean }> = [];
  const regex = /([\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*)|([^\p{L}\p{N}]+)/gu;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    out.push({
      segment: m[0],
      index: m.index,
      isWordLike: Boolean(m[1]),
    });
  }
  return out;
}

/**
 * Segments text via `Intl.Segmenter(langId, { granularity: 'word' })` with exact
 * UTF-16 character offsets (`startIndex` / `endIndex`), apostrophe elision splitting
 * for French/Italian, and `pinyin-pro` ruby generation for Mandarin Chinese.
 */
export function tokenizeMultilingualText(langId: string, text: string): Token[] {
  if (!text) return [];

  let rawSegments: Array<{ segment: string; index: number; isWordLike: boolean }> = [];
  if (typeof Intl !== 'undefined' && typeof (Intl as any).Segmenter === 'function') {
    try {
      const segmenter = new (Intl as any).Segmenter(langId, { granularity: 'word' });
      for (const seg of segmenter.segment(text)) {
        rawSegments.push({
          segment: seg.segment,
          index: seg.index,
          isWordLike: Boolean(seg.isWordLike),
        });
      }
    } catch {
      rawSegments = segmentTextFallback(text);
    }
  } else {
    rawSegments = segmentTextFallback(text);
  }

  const tokens: Token[] = [];
  let tokenSeq = 0;

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    if (!seg.segment) continue;

    if (!seg.isWordLike) {
      // Merge French/Italian elision like `l` + `'` + `arbre` when Intl.Segmenter splits on `'`
      const next = rawSegments[i + 1];
      const prevTok = tokens[tokens.length - 1];
      if (
        (langId === 'fr' || langId === 'it') &&
        (seg.segment === "'" || seg.segment === '’') &&
        prevTok &&
        prevTok.isWord &&
        next &&
        next.isWordLike &&
        /^(l|d|qu|j|c|s|n|m|t|dell|all|dall|nell|sull|coll|un|gl)$/i.test(prevTok.surface)
      ) {
        prevTok.surface += seg.segment;
        prevTok.endIndex += seg.segment.length;
        prevTok.baseForm = prevTok.surface.toLowerCase();
        continue;
      }

      const isPunct = /[^\s]/.test(seg.segment);
      tokens.push({
        id: `${langId}-tok-${tokenSeq++}-${seg.index}`,
        surface: seg.segment,
        baseForm: seg.segment,
        isWord: false,
        isPunctuation: isPunct,
        startIndex: seg.index,
        endIndex: seg.index + seg.segment.length,
      });
      continue;
    }

    const parts = splitElisionSegment(langId, seg.segment, seg.index);
    for (const part of parts) {
      if (!part.surface) continue;

      if (langId === 'zh' && HANZI_REGEX.test(part.surface)) {
        const pyInfo = buildMandarinPinyinSegments(part.surface);
        const starterEntry = findStarterEntry(langId, part.surface);
        tokens.push({
          id: `${langId}-tok-${tokenSeq++}-${part.startIndex}`,
          surface: part.surface,
          baseForm: part.surface,
          reading: pyInfo.reading || starterEntry?.readings?.[0] || '',
          furiganaSegments: pyInfo.furiganaSegments,
          isWord: true,
          isPunctuation: false,
          level: starterEntry?.level,
          frequencyRank: starterEntry?.frequencyRank,
          startIndex: part.startIndex,
          endIndex: part.endIndex,
        });
      } else {
        const starterEntry = findStarterEntry(langId, part.surface);
        tokens.push({
          id: `${langId}-tok-${tokenSeq++}-${part.startIndex}`,
          surface: part.surface,
          baseForm: starterEntry?.word || part.surface.toLowerCase(),
          reading: starterEntry?.readings?.[0],
          isWord: true,
          isPunctuation: false,
          level: starterEntry?.level,
          frequencyRank: starterEntry?.frequencyRank,
          startIndex: part.startIndex,
          endIndex: part.endIndex,
        });
      }
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Language-Specific Normalization & Stemming Candidates
// ---------------------------------------------------------------------------

function stripAccentsGerman(s: string): string {
  return s.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u');
}

function generateGermanCandidates(word: string): string[] {
  const out = new Set<string>([word, word.toLowerCase()]);
  const lower = word.toLowerCase();
  const cap = lower.charAt(0).toUpperCase() + lower.slice(1);
  out.add(cap);

  // Prefix ge- for past participles (gelernt -> lernen, gemacht -> machen)
  if (lower.startsWith('ge') && lower.length > 5) {
    const inner = lower.slice(2);
    if (inner.endsWith('t')) {
      const stem = inner.slice(0, -1);
      out.add(`${stem}en`);
      out.add(`${stem}n`);
    } else if (inner.endsWith('en')) {
      out.add(inner);
    }
  }

  const suffixes = ['en', 'er', 'es', 'em', 'e', 'n', 's', 'st', 't', 'te', 'ten', 'tet', 'test'];
  for (const suf of suffixes) {
    if (lower.endsWith(suf) && lower.length - suf.length >= 2) {
      const stem = lower.slice(0, -suf.length);
      out.add(stem);
      out.add(stem.charAt(0).toUpperCase() + stem.slice(1));
      out.add(`${stem}en`);
      const unumlaut = stripAccentsGerman(stem);
      out.add(unumlaut);
      out.add(unumlaut.charAt(0).toUpperCase() + unumlaut.slice(1));
    }
  }
  return Array.from(out);
}

function generateRomanceOrDutchCandidates(langId: string, word: string): string[] {
  const clean = word.replace(/^(l|d|qu|j|c|s|n|m|t|dell|all|dall|nell|sull|un)['’]/i, '');
  const lower = clean.toLowerCase();
  const out = new Set<string>([word, word.toLowerCase(), clean, lower]);

  if (langId === 'fr') {
    const sufs = ['aient', 'ions', 'iez', 'ons', 'ez', 'ent', 'ais', 'ait', 'es', 'ée', 'és', 'ées', 'e', 's', 'x', 'é'];
    for (const suf of sufs) {
      if (lower.endsWith(suf) && lower.length - suf.length >= 2) {
        const stem = lower.slice(0, -suf.length);
        out.add(stem);
        out.add(`${stem}er`);
        out.add(`${stem}ir`);
        out.add(`${stem}re`);
      }
    }
  } else if (langId === 'it') {
    const sufs = ['iamo', 'ate', 'ete', 'ite', 'ano', 'ono', 'ato', 'uto', 'ito', 'o', 'a', 'i', 'e'];
    for (const suf of sufs) {
      if (lower.endsWith(suf) && lower.length - suf.length >= 2) {
        const stem = lower.slice(0, -suf.length);
        out.add(stem);
        out.add(`${stem}are`);
        out.add(`${stem}ere`);
        out.add(`${stem}ire`);
      }
    }
  } else if (langId === 'pt') {
    if (lower.endsWith('ões') && lower.length > 4) {
      out.add(`${lower.slice(0, -3)}ão`);
    }
    const sufs = ['amos', 'emos', 'imos', 'ado', 'ido', 'es', 'os', 'as', 'am', 'em', 'o', 'a', 's'];
    for (const suf of sufs) {
      if (lower.endsWith(suf) && lower.length - suf.length >= 2) {
        const stem = lower.slice(0, -suf.length);
        out.add(stem);
        out.add(`${stem}ar`);
        out.add(`${stem}er`);
        out.add(`${stem}ir`);
      }
    }
  } else if (langId === 'nl') {
    if (lower.startsWith('ge') && lower.length > 5) {
      const inner = lower.slice(2);
      if (inner.endsWith('d') || inner.endsWith('t')) {
        out.add(`${inner.slice(0, -1)}en`);
      } else {
        out.add(inner);
      }
    }
    const sufs = ['den', 'ten', 'de', 'te', 'en', 'e', 's', 't'];
    for (const suf of sufs) {
      if (lower.endsWith(suf) && lower.length - suf.length >= 2) {
        const stem = lower.slice(0, -suf.length);
        out.add(stem);
        out.add(`${stem}en`);
      }
    }
  }
  return Array.from(out);
}

const TURKISH_SUFFIXES = [
  'ıyorum', 'iyorum', 'uyorum', 'üyorum',
  'ıyor', 'iyor', 'uyor', 'üyor',
  'yorum', 'yorsun', 'yoruz', 'yorlar', 'yor',
  'acaksın', 'eceksin', 'acak', 'ecek',
  'mış', 'miş', 'muş', 'müş',
  'lar', 'ler',
  'dan', 'den', 'tan', 'ten',
  'nda', 'nde', 'da', 'de', 'ta', 'te',
  'nın', 'nin', 'nun', 'nün', 'ın', 'in', 'un', 'ün',
  'ya', 'ye', 'yı', 'yi', 'yu', 'yü',
  'ım', 'im', 'um', 'üm',
  'sı', 'si', 'su', 'sü',
  'lı', 'li', 'lu', 'lü',
  'dı', 'di', 'du', 'dü', 'tı', 'ti', 'tu', 'tü',
  'a', 'e', 'ı', 'i', 'u', 'ü',
].sort((a, b) => b.length - a.length);

function reverseTurkishMutation(stem: string): string[] {
  const res = [stem];
  if (stem.endsWith('b')) res.push(stem.slice(0, -1) + 'p');
  if (stem.endsWith('c')) res.push(stem.slice(0, -1) + 'ç');
  if (stem.endsWith('d')) res.push(stem.slice(0, -1) + 't');
  if (stem.endsWith('ğ')) res.push(stem.slice(0, -1) + 'k');
  return res;
}

export function generateTurkishCandidates(word: string): string[] {
  const lower = word.toLocaleLowerCase('tr-TR');
  const out = new Set<string>([word, lower]);

  // Iteratively strip up to 3 layers of agglutinative suffixes (longest suffix first)
  let frontier = [lower];
  for (let depth = 0; depth < 3; depth++) {
    const nextFrontier: string[] = [];
    for (const cur of frontier) {
      for (const suf of TURKISH_SUFFIXES) {
        if (cur.endsWith(suf) && cur.length - suf.length >= 2) {
          const stem = cur.slice(0, -suf.length);
          for (const candidate of reverseTurkishMutation(stem)) {
            if (!out.has(candidate)) {
              out.add(candidate);
              nextFrontier.push(candidate);
            }
            // Verb infinitive forms
            out.add(`${candidate}mek`);
            out.add(`${candidate}mak`);
          }
        }
      }
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier.slice(0, 12);
  }
  return Array.from(out);
}

const KOREAN_ENDINGS = [
  '에서는', '으로는', '에게서', '습니다', 'ㅂ니다', '었어요', '았어요', '였어요',
  '으세요', '하세요', '해요', '에서', '에게', '한테', '으로', '부터', '까지',
  '하고', '보다', '처럼', '만큼', '세요', '지만', '으면', '은', '는', '이', '가',
  '을', '를', '의', '에', '로', '와', '과', '도', '만', '요', '고', '서', '어', '아', '여',
].sort((a, b) => b.length - a.length);

export function generateKoreanCandidates(word: string): string[] {
  const trimmed = word.trim();
  const out = new Set<string>([trimmed]);
  if (!trimmed) return [];

  for (const end of KOREAN_ENDINGS) {
    if (trimmed.endsWith(end) && trimmed.length > end.length) {
      const stem = trimmed.slice(0, -end.length);
      out.add(stem);
      out.add(`${stem}다`);
      out.add(`${stem}하다`);
    }
  }
  return Array.from(out);
}

export function generateLookupCandidates(langId: string, word: string, lemma?: string): string[] {
  const candidates = new Set<string>();
  const inputs = [word, lemma].filter((v): v is string => Boolean(v && v.trim()));

  for (const input of inputs) {
    const clean = input.trim();
    candidates.add(clean);
    candidates.add(clean.toLowerCase());

    if (langId === 'de') {
      for (const c of generateGermanCandidates(clean)) candidates.add(c);
    } else if (langId === 'fr' || langId === 'it' || langId === 'pt' || langId === 'nl') {
      for (const c of generateRomanceOrDutchCandidates(langId, clean)) candidates.add(c);
    } else if (langId === 'tr') {
      for (const c of generateTurkishCandidates(clean)) candidates.add(c);
    } else if (langId === 'ko') {
      for (const c of generateKoreanCandidates(clean)) candidates.add(c);
    }
  }

  return Array.from(candidates);
}

// ---------------------------------------------------------------------------
// Starter & IndexedDB Lookup Helpers
// ---------------------------------------------------------------------------

function buildStarterLookupMap(langId: string): Map<string, StarterLexiconEntry> {
  const map = new Map<string, StarterLexiconEntry>();
  const list = STARTER_LEXICONS[langId] || [];
  for (const entry of list) {
    const keys = [entry.word, entry.word.toLowerCase(), ...(entry.aliases || [])];
    for (const k of keys) {
      const norm = k.trim().toLowerCase();
      if (norm && !map.has(norm)) {
        map.set(norm, entry);
      }
      if (k.trim() && !map.has(k.trim())) {
        map.set(k.trim(), entry);
      }
    }
  }
  return map;
}

const STARTER_MAP_CACHE = new Map<string, Map<string, StarterLexiconEntry>>();

function getStarterMap(langId: string): Map<string, StarterLexiconEntry> {
  let map = STARTER_MAP_CACHE.get(langId);
  if (!map) {
    map = buildStarterLookupMap(langId);
    STARTER_MAP_CACHE.set(langId, map);
  }
  return map;
}

export function findStarterEntry(langId: string, word: string, lemma?: string): StarterLexiconEntry | null {
  const map = getStarterMap(langId);
  const candidates = generateLookupCandidates(langId, word, lemma);
  for (const c of candidates) {
    const direct = map.get(c) || map.get(c.toLowerCase());
    if (direct) return direct;
  }
  return null;
}

function dbEntryToDictionaryEntry(langId: string, row: JmdictEntryItem): DictionaryEntry {
  const primaryReading =
    row.primaryReading ||
    (langId === 'zh' ? buildMandarinPinyinSegments(row.primaryWord).reading : '');
  const readings = row.kana?.map((k) => k.text).filter(Boolean) || [];
  if (primaryReading && !readings.includes(primaryReading)) {
    readings.unshift(primaryReading);
  }
  const meanings = row.senses?.flatMap((s) => s.glosses) || [];
  const partsOfSpeech = Array.from(
    new Set(row.senses?.flatMap((s) => s.partsOfSpeech || []) || [])
  );
  const freqInfo = deriveFrequencyInfo(row.priorityTags || [], row.frequencyRank);
  const pySegs =
    langId === 'zh' ? buildMandarinPinyinSegments(row.primaryWord).furiganaSegments : undefined;

  return {
    id: row.id,
    word: row.primaryWord,
    readings,
    meanings,
    partsOfSpeech: partsOfSpeech.length > 0 ? partsOfSpeech : ['Word'],
    level: row.jlptLevel || mapFrequencyRankToLevel(langId, row.frequencyRank),
    frequencyRank: row.frequencyRank,
    frequencyBand: row.frequencyBand || freqInfo.frequencyBand,
    furiganaSegments: pySegs,
    isSampleFallback: row.importIds?.some((id) => id.startsWith('starter-')) ?? false,
    sourceKind: 'dictionary',
    importIds: row.importIds,
  };
}

function starterEntryToDictionaryEntry(langId: string, entry: StarterLexiconEntry): DictionaryEntry {
  const freqInfo = deriveFrequencyInfo([], entry.frequencyRank);
  const pyInfo =
    langId === 'zh' ? buildMandarinPinyinSegments(entry.word) : { reading: '', furiganaSegments: undefined };

  const readings =
    entry.readings && entry.readings.length > 0
      ? entry.readings
      : pyInfo.reading
      ? [pyInfo.reading]
      : [];

  return {
    id: `starter-${langId}-${entry.word}`,
    word: entry.word,
    readings,
    meanings: entry.meanings,
    partsOfSpeech: entry.partsOfSpeech,
    level: entry.level || mapFrequencyRankToLevel(langId, entry.frequencyRank),
    frequencyRank: entry.frequencyRank,
    frequencyBand: freqInfo.frequencyBand,
    furiganaSegments: pyInfo.furiganaSegments,
    examples: entry.examples,
    isSampleFallback: true,
    sourceKind: 'dictionary',
  };
}

export interface MultilingualPackConfig {
  id: string;
  name: string;
  nativeName: string;
  flagEmoji: string;
  description: string;
  ocrCode: string;
  sttCode: string;
  ttsCode: string;
  levelSystem: DifficultyLevelSystem;
  supportsRubyAnnotations: boolean;
  sampleTestPhrase: string;
  packSizeBytes: number;
  packSizeFormatted: string;
  packVersion: string;
  packTokenizerLabel: string;
  packSourceLabel: string;
  assetsManifest: PackAssetManifestItem[];
  grammarPoints?: GrammarPoint[];
}

export function createMultilingualLanguagePack(config: MultilingualPackConfig): LanguagePack {
  const starterList = STARTER_LEXICONS[config.id] || [];

  return {
    id: config.id,
    name: config.name,
    nativeName: config.nativeName,
    flagEmoji: config.flagEmoji,
    description: config.description,
    ocrCode: config.ocrCode,
    sttCode: config.sttCode,
    ttsCode: config.ttsCode,
    levelSystem: config.levelSystem,
    supportsRubyAnnotations: config.supportsRubyAnnotations,
    sampleTestPhrase: config.sampleTestPhrase,
    packSizeBytes: config.packSizeBytes,
    packSizeFormatted: config.packSizeFormatted,
    packVersion: config.packVersion,
    packTokenizerLabel: config.packTokenizerLabel,
    packSourceLabel: config.packSourceLabel,
    assetsManifest: config.assetsManifest,

    async tokenize(text: string): Promise<Token[]> {
      return tokenizeMultilingualText(config.id, text);
    },

    async lookup(word: string, lemma?: string): Promise<DictionaryEntry | null> {
      const candidates = generateLookupCandidates(config.id, word, lemma);

      // 1. Check IndexedDB entries for this language first
      try {
        if (candidates.length > 0) {
          const matches = await db.jmdictEntries
            .where('forms')
            .anyOf(candidates)
            .filter((r) => r.languageCode === config.id)
            .toArray();

          if (matches.length > 0) {
            // Prefer exact match over stemmed match, then highest priorityScore
            const exactLower = word.trim().toLowerCase();
            matches.sort((a, b) => {
              const aExact = a.primaryWord.toLowerCase() === exactLower ? 1 : 0;
              const bExact = b.primaryWord.toLowerCase() === exactLower ? 1 : 0;
              if (aExact !== bExact) return bExact - aExact;
              return (b.priorityScore || 0) - (a.priorityScore || 0);
            });
            const converted = matches.map((m) => dbEntryToDictionaryEntry(config.id, m));
            return {
              ...converted[0],
              allEntries: converted,
            };
          }
        }
      } catch {
        // Fallback smoothly to bundled starter lexicon
      }

      // 2. Check bundled starter lexicon
      const starter = findStarterEntry(config.id, word, lemma);
      if (starter) {
        return starterEntryToDictionaryEntry(config.id, starter);
      }

      // 3. Mandarin character fallback: build pinyin even for unindexed Hanzi compounds
      if (config.id === 'zh' && HANZI_REGEX.test(word)) {
        const pyInfo = buildMandarinPinyinSegments(word);
        return {
          id: `zh-pinyin-${word}`,
          word,
          readings: pyInfo.reading ? [pyInfo.reading] : [],
          meanings: [`No dictionary entry found for "${word}".`],
          partsOfSpeech: ['Word'],
          furiganaSegments: pyInfo.furiganaSegments,
          isSampleFallback: true,
        };
      }

      return null;
    },

    async searchDictionary(query: string, limit = 20): Promise<DictionaryEntry[]> {
      const q = query.trim().toLowerCase();
      if (!q) {
        return starterList.slice(0, limit).map((e) => starterEntryToDictionaryEntry(config.id, e));
      }

      const results: DictionaryEntry[] = [];
      const seen = new Set<string>();

      try {
        const dbMatches = await db.jmdictEntries
          .where('languageCode')
          .equals(config.id)
          .filter(
            (e) =>
              e.primaryWord.toLowerCase().includes(q) ||
              e.forms.some((f) => f.toLowerCase().includes(q)) ||
              e.senses.some((s) => s.glosses.some((g) => g.toLowerCase().includes(q)))
          )
          .limit(limit)
          .toArray();
        for (const m of dbMatches) {
          const item = dbEntryToDictionaryEntry(config.id, m);
          if (!seen.has(item.word.toLowerCase())) {
            seen.add(item.word.toLowerCase());
            results.push(item);
          }
        }
      } catch {
        // Ignore DB error in offline/SSR contexts
      }

      for (const entry of starterList) {
        if (results.length >= limit) break;
        if (seen.has(entry.word.toLowerCase())) continue;
        const hit =
          entry.word.toLowerCase().includes(q) ||
          (entry.readings || []).some((r) => r.toLowerCase().includes(q)) ||
          entry.meanings.some((m) => m.toLowerCase().includes(q));
        if (hit) {
          seen.add(entry.word.toLowerCase());
          results.push(starterEntryToDictionaryEntry(config.id, entry));
        }
      }

      return results.slice(0, limit);
    },

    getFrequency(word: string): number | null {
      return findStarterEntry(config.id, word)?.frequencyRank ?? null;
    },

    getLevel(word: string): string | null {
      const entry = findStarterEntry(config.id, word);
      if (!entry) return null;
      return entry.level || mapFrequencyRankToLevel(config.id, entry.frequencyRank) || null;
    },

    getReading(token: Token | string) {
      const surface = typeof token === 'string' ? token : token.surface;
      if (config.id === 'zh' && HANZI_REGEX.test(surface)) {
        const pyInfo = buildMandarinPinyinSegments(surface);
        return {
          displayReading: pyInfo.reading || undefined,
          furiganaSegments: pyInfo.furiganaSegments,
          romanization: pyInfo.reading || undefined,
        };
      }
      const starter = findStarterEntry(config.id, surface);
      const reading = starter?.readings?.[0] || (typeof token !== 'string' ? token.reading : undefined);
      return {
        displayReading: reading,
        romanization: reading,
      };
    },

    async lookupGrammar(query: string): Promise<GrammarPoint[]> {
      const points = config.grammarPoints || [];
      const q = query.trim().toLowerCase();
      if (!q) return points;
      return points.filter(
        (g) =>
          g.title.toLowerCase().includes(q) ||
          g.pattern.toLowerCase().includes(q) ||
          g.explanation.toLowerCase().includes(q)
      );
    },
  };
}
