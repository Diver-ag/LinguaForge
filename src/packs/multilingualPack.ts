import { pinyin } from 'pinyin-pro';
import {
  mapFrequencyRankToLevel,
  type DictionaryEntry,
  type DifficultyLevelSystem,
  type ExampleSentence,
  type FuriganaSegment,
  type GrammarComponent,
  type GrammarPoint,
  type GrammarStep,
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
const HANZI_SPAN_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]+/g;

// ---------------------------------------------------------------------------
// Mandarin Dictionary Cache (Forward Longest-Dictionary-Match)
// ---------------------------------------------------------------------------

let zhLexiconCache: { words: Set<string>; maxLen: number } | null = null;

export function invalidateMandarinLexiconCache(): void {
  zhLexiconCache = null;
}

function getStarterZhHeadwords(): { words: Set<string>; maxLen: number } {
  const words = new Set<string>();
  let maxLen = 2;
  for (const entry of STARTER_LEXICONS.zh || []) {
    if (entry.word.length >= 2 && HANZI_REGEX.test(entry.word)) {
      words.add(entry.word);
      if (entry.word.length > maxLen) maxLen = Math.min(12, entry.word.length);
    }
  }
  return { words, maxLen };
}

async function getMandarinLexiconCache(): Promise<{ words: Set<string>; maxLen: number }> {
  if (zhLexiconCache) return zhLexiconCache;

  const { words, maxLen: starterMax } = getStarterZhHeadwords();
  let maxLen = starterMax;

  try {
    const entries = await db.jmdictEntries.where('languageCode').equals('zh').toArray();
    for (const item of entries) {
      if (item.primaryWord && item.primaryWord.length >= 2 && HANZI_REGEX.test(item.primaryWord)) {
        words.add(item.primaryWord);
        if (item.primaryWord.length <= 12 && item.primaryWord.length > maxLen) {
          maxLen = item.primaryWord.length;
        }
      }
      for (const k of item.kanji || []) {
        if (k.text && k.text.length >= 2 && HANZI_REGEX.test(k.text)) {
          words.add(k.text);
          if (k.text.length <= 12 && k.text.length > maxLen) {
            maxLen = k.text.length;
          }
        }
      }
    }
  } catch {
    // Ignore DB errors in SSR/non-browser environments
  }

  zhLexiconCache = { words, maxLen };
  return zhLexiconCache;
}

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

// ---------------------------------------------------------------------------
// Elision & Language-Specific Tokenization
// ---------------------------------------------------------------------------

const FR_ELISION_RE = /^(l|d|qu|j|c|s|n|m|t|jusqu|lorsqu|puisqu|quoiqu)['’](.+)$/i;
const IT_ELISION_RE = /^(dell|all|dall|nell|sull|coll|un|l|d|c|s|n|m|t|gl)['’](.+)$/i;
const FR_BARE_ELISION_RE = /^(l|d|qu|j|c|s|n|m|t|jusqu|lorsqu|puisqu|quoiqu)['’]$/i;
const IT_BARE_ELISION_RE = /^(dell|all|dall|nell|sull|coll|un|l|d|c|s|n|m|t|gl)['’]$/i;

function isBareElisionPrefix(langId: string, token: string): boolean {
  const clean = token.trim();
  if (langId === 'fr') return FR_BARE_ELISION_RE.test(clean);
  if (langId === 'it') return IT_BARE_ELISION_RE.test(clean);
  return false;
}

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

const EDGE_PUNCT_RE = /^([.,!?;:"'()\[\]{}「」『』《》〈〉【】（）…—·<>~。！？、，．：；]+)?(.*?)([.,!?;:"'()\[\]{}「」『』《》〈〉【】（）…—·<>~。！？、，．：；]+)?$/;

/**
 * Space-delimited tokenizer for Korean (keeps each eojeol intact as ONE word token)
 * and Turkish (keeps each agglutinative word intact as ONE word token), separating only
 * attached leading/trailing punctuation while maintaining exact UTF-16 offsets.
 */
function tokenizeWhitespaceLanguage(langId: 'ko' | 'tr', text: string): Token[] {
  const tokens: Token[] = [];
  let tokenSeq = 0;
  const chunkRe = /(\s+)|(\S+)/g;
  let m: RegExpExecArray | null;

  while ((m = chunkRe.exec(text)) !== null) {
    const chunk = m[0];
    const baseIdx = m.index;

    if (m[1]) {
      // Whitespace span
      tokens.push({
        id: `${langId}-tok-${tokenSeq++}-${baseIdx}`,
        surface: chunk,
        baseForm: chunk,
        isWord: false,
        isPunctuation: false,
        startIndex: baseIdx,
        endIndex: baseIdx + chunk.length,
      });
      continue;
    }

    const edgeMatch = EDGE_PUNCT_RE.exec(chunk);
    const leading = edgeMatch?.[1] || '';
    const core = edgeMatch?.[2] || '';
    const trailing = edgeMatch?.[3] || '';

    if (!core) {
      // Pure punctuation chunk
      tokens.push({
        id: `${langId}-tok-${tokenSeq++}-${baseIdx}`,
        surface: chunk,
        baseForm: chunk,
        isWord: false,
        isPunctuation: true,
        startIndex: baseIdx,
        endIndex: baseIdx + chunk.length,
      });
      continue;
    }

    if (leading) {
      tokens.push({
        id: `${langId}-tok-${tokenSeq++}-${baseIdx}`,
        surface: leading,
        baseForm: leading,
        isWord: false,
        isPunctuation: true,
        startIndex: baseIdx,
        endIndex: baseIdx + leading.length,
      });
    }

    const coreStart = baseIdx + leading.length;
    const coreEnd = coreStart + core.length;
    const starterEntry = findStarterEntry(langId, core);

    tokens.push({
      id: `${langId}-tok-${tokenSeq++}-${coreStart}`,
      surface: core,
      baseForm: starterEntry?.word || (langId === 'tr' ? core.toLocaleLowerCase('tr-TR') : core),
      reading: starterEntry?.readings?.[0],
      isWord: /[\p{L}\p{N}]/u.test(core),
      isPunctuation: !/[\p{L}\p{N}]/u.test(core),
      level: starterEntry?.level,
      frequencyRank: starterEntry?.frequencyRank,
      startIndex: coreStart,
      endIndex: coreEnd,
    });

    if (trailing) {
      tokens.push({
        id: `${langId}-tok-${tokenSeq++}-${coreEnd}`,
        surface: trailing,
        baseForm: trailing,
        isWord: false,
        isPunctuation: true,
        startIndex: coreEnd,
        endIndex: coreEnd + trailing.length,
      });
    }
  }

  return tokens;
}

/**
 * Mandarin tokenizer combining forward longest-dictionary-match over CC-CEDICT/starter
 * multi-character headwords with `Intl.Segmenter('zh', { granularity: 'word' })`.
 */
function tokenizeMandarinText(
  text: string,
  knownWords: Set<string>,
  maxWordLen: number
): Token[] {
  const tokens: Token[] = [];
  let tokenSeq = 0;

  const hasIntlSegmenter =
    typeof Intl !== 'undefined' && typeof (Intl as any).Segmenter === 'function';
  const zhSegmenter = hasIntlSegmenter
    ? new (Intl as any).Segmenter('zh', { granularity: 'word' })
    : null;

  let cursor = 0;
  HANZI_SPAN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  const emitNonHanziSpan = (slice: string, offset: number) => {
    if (!slice) return;
    const segs = zhSegmenter
      ? Array.from(zhSegmenter.segment(slice) as Iterable<{ segment: string; index: number; isWordLike: boolean }>)
      : segmentTextFallback(slice);
    for (const seg of segs) {
      if (!seg.segment) continue;
      const start = offset + seg.index;
      const isPunct = !seg.isWordLike && /[^\s]/.test(seg.segment);
      tokens.push({
        id: `zh-tok-${tokenSeq++}-${start}`,
        surface: seg.segment,
        baseForm: seg.segment,
        isWord: Boolean(seg.isWordLike),
        isPunctuation: isPunct,
        startIndex: start,
        endIndex: start + seg.segment.length,
      });
    }
  };

  while ((match = HANZI_SPAN_REGEX.exec(text)) !== null) {
    if (match.index > cursor) {
      emitNonHanziSpan(text.slice(cursor, match.index), cursor);
    }

    const span = match[0];
    const spanOffset = match.index;

    // Precompute Intl.Segmenter word boundaries within this Hanzi span
    const intlByStart = new Map<number, string>();
    if (zhSegmenter) {
      for (const s of zhSegmenter.segment(span)) {
        if (s.segment && s.isWordLike) {
          intlByStart.set(s.index, s.segment);
        }
      }
    }

    let pos = 0;
    while (pos < span.length) {
      // 1. Forward longest-dictionary-match (>= 2 chars)
      let dictMatched = '';
      const upper = Math.min(maxWordLen, span.length - pos);
      for (let len = upper; len >= 2; len--) {
        const sub = span.slice(pos, pos + len);
        if (knownWords.has(sub)) {
          dictMatched = sub;
          break;
        }
      }

      let chosen = dictMatched;
      if (!chosen) {
        const seg = intlByStart.get(pos);
        if (seg && seg.length > 0) {
          // Ensure Intl.Segmenter segment doesn't cross into the start of a longer dictionary match
          let cutPos = seg.length;
          for (let inner = 1; inner < seg.length; inner++) {
            const innerUpper = Math.min(maxWordLen, span.length - (pos + inner));
            let innerHasMatch = false;
            for (let len = innerUpper; len >= 2; len--) {
              if (knownWords.has(span.slice(pos + inner, pos + inner + len))) {
                innerHasMatch = true;
                break;
              }
            }
            if (innerHasMatch) {
              cutPos = inner;
              break;
            }
          }
          chosen = span.slice(pos, pos + cutPos);
        } else {
          chosen = span.slice(pos, pos + 1);
        }
      }

      const startIndex = spanOffset + pos;
      const endIndex = startIndex + chosen.length;
      const pyInfo = buildMandarinPinyinSegments(chosen);
      const starterEntry = findStarterEntry('zh', chosen);

      tokens.push({
        id: `zh-tok-${tokenSeq++}-${startIndex}`,
        surface: chosen,
        baseForm: chosen,
        reading: chosen === '的' ? 'de' : pyInfo.reading || starterEntry?.readings?.[0] || '',
        furiganaSegments: pyInfo.furiganaSegments,
        partOfSpeech: chosen === '的' ? 'Grammar Particle' : starterEntry?.partsOfSpeech?.[0],
        isWord: true,
        isPunctuation: false,
        level: chosen === '的' ? 'HSK 1' : starterEntry?.level,
        frequencyRank: chosen === '的' ? 1 : starterEntry?.frequencyRank,
        startIndex,
        endIndex,
      });

      pos += chosen.length;
    }

    cursor = match.index + span.length;
  }

  if (cursor < text.length) {
    emitNonHanziSpan(text.slice(cursor), cursor);
  }

  return tokens;
}

/**
 * Segments text with exact UTF-16 character offsets (`startIndex` / `endIndex`),
 * language-specific word grouping (Korean eojeol, Turkish agglutinative words, Mandarin
 * longest-dictionary-match + Intl.Segmenter, French/Italian non-lookupable elision prefixes),
 * and `pinyin-pro` ruby generation for Mandarin Chinese.
 */
export function tokenizeMultilingualText(
  langId: string,
  text: string,
  zhDictionaryWords?: { words: Set<string>; maxLen: number }
): Token[] {
  if (!text) return [];

  if (langId === 'ko' || langId === 'tr') {
    return tokenizeWhitespaceLanguage(langId, text);
  }

  if (langId === 'zh') {
    const dict = zhDictionaryWords || zhLexiconCache || getStarterZhHeadwords();
    return tokenizeMandarinText(text, dict.words, dict.maxLen);
  }

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
        next &&
        next.isWordLike &&
        /^(l|d|qu|j|c|s|n|m|t|jusqu|lorsqu|puisqu|quoiqu|dell|all|dall|nell|sull|coll|un|gl)$/i.test(
          prevTok.surface
        )
      ) {
        prevTok.surface += seg.segment;
        prevTok.endIndex += seg.segment.length;
        prevTok.baseForm = prevTok.surface.toLowerCase();
        // Mark elision prefix non-word so only the content word triggers lookup/click
        prevTok.isWord = false;
        prevTok.isPunctuation = false;
        prevTok.partOfSpeech = 'Elision';
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

      if (part.isElisionPrefix) {
        tokens.push({
          id: `${langId}-tok-${tokenSeq++}-${part.startIndex}`,
          surface: part.surface,
          baseForm: part.surface.toLowerCase(),
          partOfSpeech: 'Elision',
          isWord: false,
          isPunctuation: false,
          startIndex: part.startIndex,
          endIndex: part.endIndex,
        });
        continue;
      }

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

  return tokens;
}

// ---------------------------------------------------------------------------
// Language-Specific Normalization & Stemming Candidates
// ---------------------------------------------------------------------------

function stripAccentsGerman(s: string): string {
  return s.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u');
}

function generateGermanCandidates(word: string): string[] {
  const out = new Set<string>();
  const lower = word.toLowerCase();

  // Prefix ge- for past participles (gelernt -> lernen, gemacht -> machen)
  if (lower.startsWith('ge') && lower.length > 5) {
    const inner = lower.slice(2);
    if (inner.endsWith('t') && inner.length - 1 >= 3) {
      const stem = inner.slice(0, -1);
      out.add(`${stem}en`);
      out.add(`${stem}n`);
    } else if (inner.endsWith('en') && inner.length >= 4) {
      out.add(inner);
    }
  }

  const suffixes = [
    'test', 'ten', 'tet', 'sten', 'ste', 'ster', 'stes', 'stem',
    'en', 'er', 'es', 'em', 'st', 'te', 'e', 'n', 's', 't',
  ];
  for (const suf of suffixes) {
    if (lower.endsWith(suf) && lower.length - suf.length >= 3) {
      const stem = lower.slice(0, -suf.length);
      out.add(stem);
      out.add(stem.charAt(0).toUpperCase() + stem.slice(1));
      out.add(`${stem}en`);
      const unumlaut = stripAccentsGerman(stem);
      if (unumlaut !== stem) {
        out.add(unumlaut);
        out.add(unumlaut.charAt(0).toUpperCase() + unumlaut.slice(1));
      }
    }
  }
  return Array.from(out);
}

function generateRomanceOrDutchCandidates(langId: string, word: string): string[] {
  const clean = word.replace(
    /^(dell|all|dall|nell|sull|coll|jusqu|lorsqu|puisqu|quoiqu|un|qu|gl|l|d|j|c|s|n|m|t)['’]/i,
    ''
  );
  const lower = clean.toLowerCase();
  const out = new Set<string>();
  if (clean !== word) out.add(clean);
  if (lower !== word.toLowerCase()) out.add(lower);

  if (langId === 'fr') {
    const frIrregAdj: Array<[string, string]> = [
      ['belles', 'beau'], ['belle', 'beau'],
      ['nouvelles', 'nouveau'], ['nouvelle', 'nouveau'],
      ['vieilles', 'vieux'], ['vieille', 'vieux'],
      ['folles', 'fou'], ['folle', 'fou'],
      ['molles', 'mou'], ['molle', 'mou'],
    ];
    for (const [f, b] of frIrregAdj) {
      if (lower === f) out.add(b);
    }
    const frAdjFem: Array<[string, string]> = [
      ['euses', 'eux'], ['euse', 'eux'],
      ['ives', 'if'], ['ive', 'if'],
      ['nnes', 'n'], ['nne', 'n'],
      ['lles', 'l'], ['lle', 'l'],
      ['ttes', 't'], ['tte', 't'],
      ['ches', 'c'], ['che', 'c'],
    ];
    for (const [fSuf, mSuf] of frAdjFem) {
      if (lower.endsWith(fSuf) && lower.length - fSuf.length >= 2) {
        out.add(`${lower.slice(0, -fSuf.length)}${mSuf}`);
      }
    }
    const sufs = ['aient', 'ions', 'iez', 'ons', 'ez', 'ent', 'ais', 'ait', 'ées', 'és', 'ée', 'es', 'e', 's', 'x', 'é'];
    for (const suf of sufs) {
      if (lower.endsWith(suf) && lower.length - suf.length >= 3) {
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
      if (lower.endsWith(suf) && lower.length - suf.length >= 3) {
        const stem = lower.slice(0, -suf.length);
        out.add(stem);
        out.add(`${stem}o`);
        out.add(`${stem}e`);
        out.add(`${stem}are`);
        out.add(`${stem}ere`);
        out.add(`${stem}ire`);
      }
    }
  } else if (langId === 'es') {
    const sufs = [
      'ábamos', 'iendo', 'amos', 'emos', 'imos', 'ando', 'ían', 'aba', 'ado', 'ido',
      'es', 'os', 'as', 'an', 'en', 'o', 'a', 'e', 's',
    ];
    for (const suf of sufs) {
      if (lower.endsWith(suf) && lower.length - suf.length >= 3) {
        const stem = lower.slice(0, -suf.length);
        out.add(stem);
        out.add(`${stem}o`);
        out.add(`${stem}e`);
        out.add(`${stem}ar`);
        out.add(`${stem}er`);
        out.add(`${stem}ir`);
      }
    }
  } else if (langId === 'pt') {
    if (lower.endsWith('ões') && lower.length - 3 >= 3) {
      out.add(`${lower.slice(0, -3)}ão`);
    }
    const sufs = ['ávamos', 'íamos', 'amos', 'emos', 'imos', 'ando', 'endo', 'indo', 'ado', 'ido', 'es', 'os', 'as', 'am', 'em', 'o', 'a', 's'];
    for (const suf of sufs) {
      if (lower.endsWith(suf) && lower.length - suf.length >= 3) {
        const stem = lower.slice(0, -suf.length);
        out.add(stem);
        out.add(`${stem}o`);
        out.add(`${stem}e`);
        out.add(`${stem}ar`);
        out.add(`${stem}er`);
        out.add(`${stem}ir`);
      }
    }
  } else if (langId === 'nl') {
    if (lower.startsWith('ge') && lower.length > 5) {
      const inner = lower.slice(2);
      if ((inner.endsWith('d') || inner.endsWith('t')) && inner.length - 1 >= 3) {
        out.add(`${inner.slice(0, -1)}en`);
      } else if (inner.length >= 3) {
        out.add(inner);
      }
    }
    if (lower.endsWith('e') && lower.length >= 4) {
      const stem = lower.slice(0, -1);
      // Dutch open-syllable vowel doubling in inflected adjectives (grote -> groot, hoge -> hoog, rode -> rood, boze -> boos)
      const openSyll = /^(.*[bcdfghjklmnpqrstvwxz])([aeiou])([bcdfghjklmnpqrstvwxz])$/.exec(stem);
      if (openSyll) {
        const [, head, v, c] = openSyll;
        const closedC = c === 'z' ? 's' : c === 'v' ? 'f' : c;
        out.add(`${head}${v}${v}${closedC}`);
      }
      if (stem.endsWith('v')) out.add(`${stem.slice(0, -1)}f`);
      if (stem.endsWith('z')) out.add(`${stem.slice(0, -1)}s`);
    }
    const sufs = ['den', 'ten', 'de', 'te', 'en', 'e', 's', 't'];
    for (const suf of sufs) {
      if (lower.endsWith(suf) && lower.length - suf.length >= 3) {
        const stem = lower.slice(0, -suf.length);
        out.add(stem);
        out.add(`${stem}en`);
      }
    }
  }
  return Array.from(out);
}

// ---------------------------------------------------------------------------
// Turkish Backward-Chaining Vowel-Harmony Suffix Analyzer
// ---------------------------------------------------------------------------

const TR_FRONT_VOWELS = new Set(['e', 'i', 'ö', 'ü']);
const TR_BACK_VOWELS = new Set(['a', 'ı', 'o', 'u']);
const TR_ROUNDED_VOWELS = new Set(['o', 'ö', 'u', 'ü']);

function lastTurkishVowel(str: string): string | null {
  for (let i = str.length - 1; i >= 0; i--) {
    const ch = str[i];
    if (TR_FRONT_VOWELS.has(ch) || TR_BACK_VOWELS.has(ch)) return ch;
  }
  return null;
}

interface TurkishSuffixRule {
  suf: string;
  harmony?: 'front' | 'back' | 'rounded-front' | 'rounded-back' | 'unrounded-front' | 'unrounded-back';
  kind: 'nominal' | 'verb' | 'verb-prog';
  meaning: string;
}

const TURKISH_SUFFIX_RULES: TurkishSuffixRule[] = ([
  // Verb tense/person
  { suf: 'iyorum', harmony: 'unrounded-front', kind: 'verb-prog', meaning: 'present continuous (I am -ing)' },
  { suf: 'ıyorum', harmony: 'unrounded-back', kind: 'verb-prog', meaning: 'present continuous (I am -ing)' },
  { suf: 'uyorum', harmony: 'rounded-back', kind: 'verb-prog', meaning: 'present continuous (I am -ing)' },
  { suf: 'üyorum', harmony: 'rounded-front', kind: 'verb-prog', meaning: 'present continuous (I am -ing)' },
  { suf: 'iyorsun', harmony: 'unrounded-front', kind: 'verb-prog', meaning: 'present continuous (you are -ing)' },
  { suf: 'ıyorsun', harmony: 'unrounded-back', kind: 'verb-prog', meaning: 'present continuous (you are -ing)' },
  { suf: 'uyorsun', harmony: 'rounded-back', kind: 'verb-prog', meaning: 'present continuous (you are -ing)' },
  { suf: 'üyorsun', harmony: 'rounded-front', kind: 'verb-prog', meaning: 'present continuous (you are -ing)' },
  { suf: 'iyoruz', harmony: 'unrounded-front', kind: 'verb-prog', meaning: 'present continuous (we are -ing)' },
  { suf: 'ıyoruz', harmony: 'unrounded-back', kind: 'verb-prog', meaning: 'present continuous (we are -ing)' },
  { suf: 'uyoruz', harmony: 'rounded-back', kind: 'verb-prog', meaning: 'present continuous (we are -ing)' },
  { suf: 'üyoruz', harmony: 'rounded-front', kind: 'verb-prog', meaning: 'present continuous (we are -ing)' },
  { suf: 'iyorlar', harmony: 'unrounded-front', kind: 'verb-prog', meaning: 'present continuous (they are -ing)' },
  { suf: 'ıyorlar', harmony: 'unrounded-back', kind: 'verb-prog', meaning: 'present continuous (they are -ing)' },
  { suf: 'uyorlar', harmony: 'rounded-back', kind: 'verb-prog', meaning: 'present continuous (they are -ing)' },
  { suf: 'üyorlar', harmony: 'rounded-front', kind: 'verb-prog', meaning: 'present continuous (they are -ing)' },
  { suf: 'iyor', harmony: 'unrounded-front', kind: 'verb-prog', meaning: 'present continuous (-ing)' },
  { suf: 'ıyor', harmony: 'unrounded-back', kind: 'verb-prog', meaning: 'present continuous (-ing)' },
  { suf: 'uyor', harmony: 'rounded-back', kind: 'verb-prog', meaning: 'present continuous (-ing)' },
  { suf: 'üyor', harmony: 'rounded-front', kind: 'verb-prog', meaning: 'present continuous (-ing)' },
  { suf: 'eceğim', harmony: 'front', kind: 'verb', meaning: 'future tense (I will)' },
  { suf: 'acağım', harmony: 'back', kind: 'verb', meaning: 'future tense (I will)' },
  { suf: 'eceksin', harmony: 'front', kind: 'verb', meaning: 'future tense (you will)' },
  { suf: 'acaksın', harmony: 'back', kind: 'verb', meaning: 'future tense (you will)' },
  { suf: 'ecek', harmony: 'front', kind: 'verb', meaning: 'future tense' },
  { suf: 'acak', harmony: 'back', kind: 'verb', meaning: 'future tense' },
  { suf: 'miş', harmony: 'unrounded-front', kind: 'verb', meaning: 'reported / inferential past' },
  { suf: 'mış', harmony: 'unrounded-back', kind: 'verb', meaning: 'reported / inferential past' },
  { suf: 'muş', harmony: 'rounded-back', kind: 'verb', meaning: 'reported / inferential past' },
  { suf: 'müş', harmony: 'rounded-front', kind: 'verb', meaning: 'reported / inferential past' },
  { suf: 'di', harmony: 'unrounded-front', kind: 'verb', meaning: 'past tense' },
  { suf: 'dı', harmony: 'unrounded-back', kind: 'verb', meaning: 'past tense' },
  { suf: 'du', harmony: 'rounded-back', kind: 'verb', meaning: 'past tense' },
  { suf: 'dü', harmony: 'rounded-front', kind: 'verb', meaning: 'past tense' },
  { suf: 'ti', harmony: 'unrounded-front', kind: 'verb', meaning: 'past tense' },
  { suf: 'tı', harmony: 'unrounded-back', kind: 'verb', meaning: 'past tense' },
  { suf: 'tu', harmony: 'rounded-back', kind: 'verb', meaning: 'past tense' },
  { suf: 'tü', harmony: 'rounded-front', kind: 'verb', meaning: 'past tense' },

  // Possessive + Case + Plural
  { suf: 'lerimiz', harmony: 'front', kind: 'nominal', meaning: 'plural + our' },
  { suf: 'larımız', harmony: 'back', kind: 'nominal', meaning: 'plural + our' },
  { suf: 'lerin', harmony: 'front', kind: 'nominal', meaning: 'plural + your / of' },
  { suf: 'ların', harmony: 'back', kind: 'nominal', meaning: 'plural + your / of' },
  { suf: 'leri', harmony: 'front', kind: 'nominal', meaning: 'plural + their / accusative' },
  { suf: 'ları', harmony: 'back', kind: 'nominal', meaning: 'plural + their / accusative' },
  { suf: 'imiz', harmony: 'unrounded-front', kind: 'nominal', meaning: 'our' },
  { suf: 'ımız', harmony: 'unrounded-back', kind: 'nominal', meaning: 'our' },
  { suf: 'umuz', harmony: 'rounded-back', kind: 'nominal', meaning: 'our' },
  { suf: 'ümüz', harmony: 'rounded-front', kind: 'nominal', meaning: 'our' },
  { suf: 'iniz', harmony: 'unrounded-front', kind: 'nominal', meaning: 'your (plural / formal)' },
  { suf: 'ınız', harmony: 'unrounded-back', kind: 'nominal', meaning: 'your (plural / formal)' },
  { suf: 'unuz', harmony: 'rounded-back', kind: 'nominal', meaning: 'your (plural / formal)' },
  { suf: 'ünüz', harmony: 'rounded-front', kind: 'nominal', meaning: 'your (plural / formal)' },
  { suf: 'den', harmony: 'front', kind: 'nominal', meaning: 'from' },
  { suf: 'dan', harmony: 'back', kind: 'nominal', meaning: 'from' },
  { suf: 'ten', harmony: 'front', kind: 'nominal', meaning: 'from' },
  { suf: 'tan', harmony: 'back', kind: 'nominal', meaning: 'from' },
  { suf: 'nde', harmony: 'front', kind: 'nominal', meaning: 'in / at / on' },
  { suf: 'nda', harmony: 'back', kind: 'nominal', meaning: 'in / at / on' },
  { suf: 'de', harmony: 'front', kind: 'nominal', meaning: 'in / at / on' },
  { suf: 'da', harmony: 'back', kind: 'nominal', meaning: 'in / at / on' },
  { suf: 'te', harmony: 'front', kind: 'nominal', meaning: 'in / at / on' },
  { suf: 'ta', harmony: 'back', kind: 'nominal', meaning: 'in / at / on' },
  { suf: 'nin', harmony: 'unrounded-front', kind: 'nominal', meaning: "your / of ('s)" },
  { suf: 'nın', harmony: 'unrounded-back', kind: 'nominal', meaning: "your / of ('s)" },
  { suf: 'nun', harmony: 'rounded-back', kind: 'nominal', meaning: "your / of ('s)" },
  { suf: 'nün', harmony: 'rounded-front', kind: 'nominal', meaning: "your / of ('s)" },
  { suf: 'yle', harmony: 'front', kind: 'nominal', meaning: 'with / by means of' },
  { suf: 'yla', harmony: 'back', kind: 'nominal', meaning: 'with / by means of' },
  { suf: 'ler', harmony: 'front', kind: 'nominal', meaning: 'plural' },
  { suf: 'lar', harmony: 'back', kind: 'nominal', meaning: 'plural' },
  { suf: 'ye', harmony: 'front', kind: 'nominal', meaning: 'to / toward' },
  { suf: 'ya', harmony: 'back', kind: 'nominal', meaning: 'to / toward' },
  { suf: 'yi', harmony: 'unrounded-front', kind: 'nominal', meaning: 'specific object (accusative)' },
  { suf: 'yı', harmony: 'unrounded-back', kind: 'nominal', meaning: 'specific object (accusative)' },
  { suf: 'yu', harmony: 'rounded-back', kind: 'nominal', meaning: 'specific object (accusative)' },
  { suf: 'yü', harmony: 'rounded-front', kind: 'nominal', meaning: 'specific object (accusative)' },
  { suf: 'in', harmony: 'unrounded-front', kind: 'nominal', meaning: 'your / of' },
  { suf: 'ın', harmony: 'unrounded-back', kind: 'nominal', meaning: 'your / of' },
  { suf: 'un', harmony: 'rounded-back', kind: 'nominal', meaning: 'your / of' },
  { suf: 'ün', harmony: 'rounded-front', kind: 'nominal', meaning: 'your / of' },
  { suf: 'im', harmony: 'unrounded-front', kind: 'nominal', meaning: 'my' },
  { suf: 'ım', harmony: 'unrounded-back', kind: 'nominal', meaning: 'my' },
  { suf: 'um', harmony: 'rounded-back', kind: 'nominal', meaning: 'my' },
  { suf: 'üm', harmony: 'rounded-front', kind: 'nominal', meaning: 'my' },
  { suf: 'i', harmony: 'unrounded-front', kind: 'nominal', meaning: 'his/her/its / specific object' },
  { suf: 'ı', harmony: 'unrounded-back', kind: 'nominal', meaning: 'his/her/its / specific object' },
  { suf: 'u', harmony: 'rounded-back', kind: 'nominal', meaning: 'his/her/its / specific object' },
  { suf: 'ü', harmony: 'rounded-front', kind: 'nominal', meaning: 'his/her/its / specific object' },
  // Derivational adjective suffixes (-li/-lı/-lu/-lü: with/having, -siz/-sız/-suz/-süz: without)
  { suf: 'li', harmony: 'unrounded-front', kind: 'nominal', meaning: 'adjective suffix: with / having' },
  { suf: 'lı', harmony: 'unrounded-back', kind: 'nominal', meaning: 'adjective suffix: with / having' },
  { suf: 'lu', harmony: 'rounded-back', kind: 'nominal', meaning: 'adjective suffix: with / having' },
  { suf: 'lü', harmony: 'rounded-front', kind: 'nominal', meaning: 'adjective suffix: with / having' },
  { suf: 'siz', harmony: 'unrounded-front', kind: 'nominal', meaning: 'adjective suffix: without' },
  { suf: 'sız', harmony: 'unrounded-back', kind: 'nominal', meaning: 'adjective suffix: without' },
  { suf: 'suz', harmony: 'rounded-back', kind: 'nominal', meaning: 'adjective suffix: without' },
  { suf: 'süz', harmony: 'rounded-front', kind: 'nominal', meaning: 'adjective suffix: without' },

  { suf: 'e', harmony: 'front', kind: 'nominal', meaning: 'to / toward' },
  { suf: 'a', harmony: 'back', kind: 'nominal', meaning: 'to / toward' },
] as TurkishSuffixRule[]).sort((a, b) => b.suf.length - a.suf.length);

function checkTurkishHarmony(stem: string, harmony?: TurkishSuffixRule['harmony']): boolean {
  if (!harmony) return true;
  const v = lastTurkishVowel(stem);
  if (!v) return true;
  const isFront = TR_FRONT_VOWELS.has(v);
  const isRounded = TR_ROUNDED_VOWELS.has(v);

  switch (harmony) {
    case 'front':
      return isFront;
    case 'back':
      return !isFront;
    case 'rounded-front':
      return isFront && isRounded;
    case 'unrounded-front':
      return isFront && !isRounded;
    case 'rounded-back':
      return !isFront && isRounded;
    case 'unrounded-back':
      return !isFront && !isRounded;
  }
}

function reverseTurkishMutation(stem: string): string[] {
  const res = [stem];
  if (stem.endsWith('b')) res.push(stem.slice(0, -1) + 'p');
  if (stem.endsWith('c')) res.push(stem.slice(0, -1) + 'ç');
  if (stem.endsWith('d')) res.push(stem.slice(0, -1) + 't');
  if (stem.endsWith('ğ')) res.push(stem.slice(0, -1) + 'k');
  return res;
}

interface TurkishAnalysis {
  lemma: string;
  steps: GrammarStep[]; // ordered left-to-right (innermost -> outermost)
}

function generateTurkishAnalyses(word: string): TurkishAnalysis[] {
  const lower = word.toLocaleLowerCase('tr-TR');
  const bestByLemma = new Map<string, GrammarStep[]>();
  if (lower.length < 2) return [];

  const record = (lemma: string, reverseSteps: GrammarStep[]) => {
    const ordered = [...reverseSteps].reverse();
    const existing = bestByLemma.get(lemma);
    // Prefer fewest chained steps or longest root match
    if (!existing || ordered.length < existing.length) {
      bestByLemma.set(lemma, ordered);
    }
  };

  let frontier: Array<{ cur: string; reverseSteps: GrammarStep[] }> = [{ cur: lower, reverseSteps: [] }];
  for (let depth = 0; depth < 4; depth++) {
    const nextFrontier: Array<{ cur: string; reverseSteps: GrammarStep[] }> = [];
    for (const { cur, reverseSteps } of frontier) {
      for (const rule of TURKISH_SUFFIX_RULES) {
        if (!cur.endsWith(rule.suf)) continue;
        // Minimum stem length: 2 chars
        if (cur.length - rule.suf.length < 2) continue;

        const rawStem = cur.slice(0, -rule.suf.length);
        if (rule.kind !== 'verb-prog' && !checkTurkishHarmony(rawStem, rule.harmony)) {
          continue;
        }

        const nextStep: GrammarStep = { suffix: rule.suf, meaning: rule.meaning, kind: rule.kind };
        const nextReverseSteps = [...reverseSteps, nextStep];

        for (const candidate of reverseTurkishMutation(rawStem)) {
          if (candidate.length < 2) continue;
          if (!bestByLemma.has(candidate)) {
            record(candidate, nextReverseSteps);
            nextFrontier.push({ cur: candidate, reverseSteps: nextReverseSteps });
          }

          if (rule.kind === 'verb' || rule.kind === 'verb-prog') {
            const v = lastTurkishVowel(candidate);
            const inf = v && TR_FRONT_VOWELS.has(v) ? `${candidate}mek` : `${candidate}mak`;
            record(inf, nextReverseSteps);
            if (rule.kind === 'verb-prog') {
              if (rule.suf.startsWith('i')) record(`${candidate}emek`, nextReverseSteps);
              if (rule.suf.startsWith('ı')) record(`${candidate}amak`, nextReverseSteps);
              if (rule.suf.startsWith('u')) {
                record(`${candidate}umak`, nextReverseSteps);
                record(`${candidate}omak`, nextReverseSteps);
              }
              if (rule.suf.startsWith('ü')) {
                record(`${candidate}ümek`, nextReverseSteps);
                record(`${candidate}ömek`, nextReverseSteps);
              }
            }
          } else {
            const v = lastTurkishVowel(candidate);
            if (v) {
              record(TR_FRONT_VOWELS.has(v) ? `${candidate}mek` : `${candidate}mak`, nextReverseSteps);
            }
          }
        }
      }
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier.slice(0, 16);
  }

  // Sort longest lemma first so lookup prefers longest valid dictionary root
  return Array.from(bestByLemma.entries())
    .map(([lemma, steps]) => ({ lemma, steps }))
    .sort((a, b) => b.lemma.length - a.lemma.length);
}

export function generateTurkishCandidates(word: string): string[] {
  return generateTurkishAnalyses(word).map((a) => a.lemma);
}

// ---------------------------------------------------------------------------
// Korean Longest-First Particle & Verb-Ending Stripper (with Jamo Coda Handling)
// ---------------------------------------------------------------------------

interface KoreanRule {
  suf: string;
  meaning: string;
  kind: 'particle' | 'ending';
  steps?: GrammarStep[];
}

const KOREAN_PARTICLE_RULES: KoreanRule[] = ([
  { suf: '에서는', meaning: 'at / in (action location) + topic marker', kind: 'particle', steps: [{ suffix: '에서', meaning: 'at / in (action location) / from' }, { suffix: '는', meaning: 'topic marker' }] },
  { suf: '으로는', meaning: 'toward / by means of + topic marker', kind: 'particle', steps: [{ suffix: '으로', meaning: 'toward / by means of' }, { suffix: '는', meaning: 'topic marker' }] },
  { suf: '에게서', meaning: 'from (someone)', kind: 'particle' },
  { suf: '한테서', meaning: 'from (someone)', kind: 'particle' },
  { suf: '에서도', meaning: 'also at / in', kind: 'particle', steps: [{ suffix: '에서', meaning: 'at / in (action location) / from' }, { suffix: '도', meaning: 'also / too' }] },
  { suf: '으로도', meaning: 'also toward / by means of', kind: 'particle', steps: [{ suffix: '으로', meaning: 'toward / by means of' }, { suffix: '도', meaning: 'also / too' }] },
  { suf: '에게도', meaning: 'also to (someone)', kind: 'particle', steps: [{ suffix: '에게', meaning: 'to (someone)' }, { suffix: '도', meaning: 'also / too' }] },
  { suf: '부터', meaning: 'from / since', kind: 'particle' },
  { suf: '까지', meaning: 'until / up to', kind: 'particle' },
  { suf: '처럼', meaning: 'like / as', kind: 'particle' },
  { suf: '만큼', meaning: 'as much as', kind: 'particle' },
  { suf: '보다', meaning: 'than (comparison)', kind: 'particle' },
  { suf: '하고', meaning: 'and / with', kind: 'particle' },
  { suf: '에서', meaning: 'at / in (action location) / from', kind: 'particle' },
  { suf: '에게', meaning: 'to (someone)', kind: 'particle' },
  { suf: '한테', meaning: 'to (someone)', kind: 'particle' },
  { suf: '으로', meaning: 'toward / by means of', kind: 'particle' },
  { suf: '와', meaning: 'and / with', kind: 'particle' },
  { suf: '과', meaning: 'and / with', kind: 'particle' },
  { suf: '은', meaning: 'topic marker', kind: 'particle' },
  { suf: '는', meaning: 'topic marker', kind: 'particle' },
  { suf: '이', meaning: 'subject marker', kind: 'particle' },
  { suf: '가', meaning: 'subject marker', kind: 'particle' },
  { suf: '을', meaning: 'object marker', kind: 'particle' },
  { suf: '를', meaning: 'object marker', kind: 'particle' },
  { suf: '에', meaning: 'to / at / in', kind: 'particle' },
  { suf: '로', meaning: 'toward / by means of', kind: 'particle' },
  { suf: '도', meaning: 'also / too', kind: 'particle' },
  { suf: '만', meaning: 'only', kind: 'particle' },
  { suf: '의', meaning: "possessive ('s / of)", kind: 'particle' },
] as KoreanRule[]).sort((a, b) => b.suf.length - a.suf.length);

const KOREAN_VERB_ENDING_RULES: KoreanRule[] = ([
  { suf: '았습니다', meaning: 'past tense + formal polite', kind: 'ending', steps: [{ suffix: '았', meaning: 'past tense' }, { suffix: '습니다', meaning: 'formal polite' }] },
  { suf: '었습니다', meaning: 'past tense + formal polite', kind: 'ending', steps: [{ suffix: '었', meaning: 'past tense' }, { suffix: '습니다', meaning: 'formal polite' }] },
  { suf: '였습니다', meaning: 'past tense + formal polite', kind: 'ending', steps: [{ suffix: '였', meaning: 'past tense' }, { suffix: '습니다', meaning: 'formal polite' }] },
  { suf: '습니다', meaning: 'formal polite', kind: 'ending' },
  { suf: '습니까', meaning: 'formal polite question', kind: 'ending' },
  { suf: '았어요', meaning: 'past tense + polite', kind: 'ending', steps: [{ suffix: '았', meaning: 'past tense' }, { suffix: '어요', meaning: 'polite present' }] },
  { suf: '었어요', meaning: 'past tense + polite', kind: 'ending', steps: [{ suffix: '었', meaning: 'past tense' }, { suffix: '어요', meaning: 'polite present' }] },
  { suf: '였어요', meaning: 'past tense + polite', kind: 'ending', steps: [{ suffix: '였', meaning: 'past tense' }, { suffix: '어요', meaning: 'polite present' }] },
  { suf: '으세요', meaning: 'honorific polite / request', kind: 'ending' },
  { suf: '하세요', meaning: 'honorific polite / request', kind: 'ending' },
  { suf: '았어', meaning: 'past tense (casual)', kind: 'ending' },
  { suf: '었어', meaning: 'past tense (casual)', kind: 'ending' },
  { suf: '였어', meaning: 'past tense (casual)', kind: 'ending' },
  { suf: '았다', meaning: 'past tense', kind: 'ending' },
  { suf: '었다', meaning: 'past tense', kind: 'ending' },
  { suf: '였다', meaning: 'past tense', kind: 'ending' },
  { suf: '해요', meaning: 'polite present', kind: 'ending' },
  { suf: '아요', meaning: 'polite present', kind: 'ending' },
  { suf: '어요', meaning: 'polite present', kind: 'ending' },
  { suf: '여요', meaning: 'polite present', kind: 'ending' },
  { suf: '세요', meaning: 'honorific polite / request', kind: 'ending' },
  { suf: '지만', meaning: 'but / although', kind: 'ending' },
  { suf: '으면', meaning: 'if / when', kind: 'ending' },
  { suf: '니까', meaning: 'because / since', kind: 'ending' },
  { suf: '으니', meaning: 'because / since', kind: 'ending' },
  { suf: '고', meaning: 'and / ~ing', kind: 'ending' },
  { suf: '지', meaning: 'negative / confirmation', kind: 'ending' },
  { suf: '기', meaning: 'nominalizer (~ing)', kind: 'ending' },
  { suf: '는', meaning: 'attributive modifier form (modifies following noun)', kind: 'ending' },
  { suf: '은', meaning: 'attributive modifier form (modifies following noun)', kind: 'ending' },
  { suf: '을', meaning: 'future modifier', kind: 'ending' },
  { suf: '요', meaning: 'polite ending', kind: 'ending' },
  { suf: '아', meaning: 'casual present / connective', kind: 'ending' },
  { suf: '어', meaning: 'casual present / connective', kind: 'ending' },
  { suf: '여', meaning: 'casual present / connective', kind: 'ending' },
] as KoreanRule[]).sort((a, b) => b.suf.length - a.suf.length);

interface KoreanLightVerbTail {
  suf: string;
  verb: '하다' | '되다';
  isAttributiveModifier?: boolean;
  extraSteps?: GrammarStep[];
}

const KO_LIGHT_VERB_TAILS: KoreanLightVerbTail[] = ([
  { suf: '했습니다', verb: '하다', extraSteps: [{ suffix: 'ㅆ', meaning: 'past tense', kind: 'ending' }, { suffix: '습니다', meaning: 'formal polite', kind: 'ending' }] },
  { suf: '했어요', verb: '하다', extraSteps: [{ suffix: 'ㅆ', meaning: 'past tense', kind: 'ending' }, { suffix: '어요', meaning: 'polite present', kind: 'ending' }] },
  { suf: '했어', verb: '하다', extraSteps: [{ suffix: 'ㅆ어', meaning: 'past tense (casual)', kind: 'ending' }] },
  { suf: '했다', verb: '하다', extraSteps: [{ suffix: 'ㅆ다', meaning: 'past tense', kind: 'ending' }] },
  { suf: '합니다', verb: '하다', extraSteps: [{ suffix: 'ㅂ니다', meaning: 'formal polite', kind: 'ending' }] },
  { suf: '합니까', verb: '하다', extraSteps: [{ suffix: 'ㅂ니까', meaning: 'formal polite question', kind: 'ending' }] },
  { suf: '하세요', verb: '하다', extraSteps: [{ suffix: '세요', meaning: 'honorific polite / request', kind: 'ending' }] },
  { suf: '해요', verb: '하다', extraSteps: [{ suffix: '여요', meaning: 'polite present', kind: 'ending' }] },
  { suf: '해', verb: '하다', extraSteps: [{ suffix: '여', meaning: 'casual present', kind: 'ending' }] },
  { suf: '하고', verb: '하다', extraSteps: [{ suffix: '고', meaning: 'and / ~ing', kind: 'ending' }] },
  { suf: '하면', verb: '하다', extraSteps: [{ suffix: '면', meaning: 'if / when', kind: 'ending' }] },
  { suf: '하지', verb: '하다', extraSteps: [{ suffix: '지', meaning: 'negative / confirmation', kind: 'ending' }] },
  { suf: '하는', verb: '하다', isAttributiveModifier: true, extraSteps: [{ suffix: '는', meaning: 'attributive modifier form (modifies following noun)', kind: 'ending' }] },
  { suf: '한', verb: '하다', isAttributiveModifier: true, extraSteps: [{ suffix: 'ㄴ', meaning: 'attributive modifier form (modifies following noun)', kind: 'ending' }] },
  { suf: '할', verb: '하다', extraSteps: [{ suffix: 'ㄹ', meaning: 'future modifier', kind: 'ending' }] },
  { suf: '하다', verb: '하다' },
  { suf: '됐습니다', verb: '되다', extraSteps: [{ suffix: 'ㅆ', meaning: 'past tense', kind: 'ending' }, { suffix: '습니다', meaning: 'formal polite', kind: 'ending' }] },
  { suf: '됐어요', verb: '되다', extraSteps: [{ suffix: 'ㅆ', meaning: 'past tense', kind: 'ending' }, { suffix: '어요', meaning: 'polite present', kind: 'ending' }] },
  { suf: '됐어', verb: '되다', extraSteps: [{ suffix: 'ㅆ어', meaning: 'past tense (casual)', kind: 'ending' }] },
  { suf: '됐다', verb: '되다', extraSteps: [{ suffix: 'ㅆ다', meaning: 'past tense', kind: 'ending' }] },
  { suf: '됩니다', verb: '되다', extraSteps: [{ suffix: 'ㅂ니다', meaning: 'formal polite', kind: 'ending' }] },
  { suf: '됩니까', verb: '되다', extraSteps: [{ suffix: 'ㅂ니까', meaning: 'formal polite question', kind: 'ending' }] },
  { suf: '돼요', verb: '되다', extraSteps: [{ suffix: '어요', meaning: 'polite present', kind: 'ending' }] },
  { suf: '되고', verb: '되다', extraSteps: [{ suffix: '고', meaning: 'and / ~ing', kind: 'ending' }] },
  { suf: '되는', verb: '되다', isAttributiveModifier: true, extraSteps: [{ suffix: '는', meaning: 'attributive modifier form (modifies following noun)', kind: 'ending' }] },
  { suf: '된', verb: '되다', isAttributiveModifier: true, extraSteps: [{ suffix: 'ㄴ', meaning: 'attributive modifier form (modifies following noun)', kind: 'ending' }] },
  { suf: '될', verb: '되다', extraSteps: [{ suffix: 'ㄹ', meaning: 'future modifier', kind: 'ending' }] },
  { suf: '되다', verb: '되다' },
] as KoreanLightVerbTail[]).sort((a, b) => b.suf.length - a.suf.length);

function parseKoreanLightVerb(word: string): { nounStem: string; tail: KoreanLightVerbTail } | null {
  const clean = word.trim();
  if (clean.length < 3) return null;
  for (const tail of KO_LIGHT_VERB_TAILS) {
    if (clean.endsWith(tail.suf) && clean.length > tail.suf.length) {
      const nounStem = clean.slice(0, -tail.suf.length);
      if (nounStem.length >= 1) {
        return { nounStem, tail };
      }
    }
  }
  return null;
}

function stripHangulCoda(syllable: string, expectedCodaIndex: number): string | null {
  const code = syllable.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return null;
  const offset = code - 0xac00;
  const jong = offset % 28;
  if (jong !== expectedCodaIndex) return null;
  return String.fromCharCode(code - jong);
}

function getHangulParts(syllable: string): { cho: number; jung: number; jong: number } | null {
  const code = syllable.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return null;
  const offset = code - 0xac00;
  const jong = offset % 28;
  const jung = ((offset - jong) / 28) % 21;
  const cho = Math.floor((offset - jong) / 28 / 21);
  return { cho, jung, jong };
}

function composeHangul(cho: number, jung: number, jong = 0): string {
  return String.fromCharCode(0xac00 + (cho * 21 + jung) * 28 + jong);
}

function addKoreanVerbStemVariants(
  stem: string,
  steps: GrammarStep[],
  suffix: string,
  record: (lemma: string, suffix: string, steps: GrammarStep[]) => void
): void {
  if (!stem) return;
  record(`${stem}다`, suffix, steps);
  record(`${stem}하다`, suffix, steps);

  const last = stem.slice(-1);
  const prefix = stem.slice(0, -1);
  const parts = getHangulParts(last);
  if (!parts) return;

  // Past tense ㅆ (jong === 20) contractions: 갔 -> 가, 왔 -> 오, 했 -> 하, 셨 -> 시, 웠 -> 우
  if (parts.jong === 20) {
    const pastSteps: GrammarStep[] = [{ suffix: 'ㅆ', meaning: 'past tense' }, ...steps];
    const noCoda = composeHangul(parts.cho, parts.jung, 0);
    record(`${prefix}${noCoda}다`, suffix, pastSteps);
    if (parts.jung === 9) {
      record(`${prefix}${composeHangul(parts.cho, 8, 0)}다`, suffix, pastSteps);
    } else if (parts.jung === 1) {
      record(`${prefix}${composeHangul(parts.cho, 0, 0)}다`, suffix, pastSteps);
    } else if (parts.jung === 14) {
      record(`${prefix}${composeHangul(parts.cho, 13, 0)}다`, suffix, pastSteps);
    } else if (parts.jung === 6) {
      record(`${prefix}${composeHangul(parts.cho, 20, 0)}다`, suffix, pastSteps);
    }
  }

  // Vowel contractions without coda (jong === 0): 커 -> 크, 써 -> 쓰, 봐 -> 보, 와 -> 오, 해 -> 하, 배워 -> 배우
  if (parts.jong === 0) {
    if (parts.jung === 4) {
      record(`${prefix}${composeHangul(parts.cho, 18, 0)}다`, suffix, steps);
    } else if (parts.jung === 9) {
      record(`${prefix}${composeHangul(parts.cho, 8, 0)}다`, suffix, steps);
    } else if (parts.jung === 14) {
      record(`${prefix}${composeHangul(parts.cho, 13, 0)}다`, suffix, steps);
    } else if (parts.jung === 1) {
      record(`${prefix}${composeHangul(parts.cho, 0, 0)}다`, suffix, steps);
    } else if (parts.jung === 6) {
      record(`${prefix}${composeHangul(parts.cho, 20, 0)}다`, suffix, steps);
    }
  }
}

interface KoreanAnalysis {
  lemma: string;
  suffix: string;
  steps: GrammarStep[];
}

function generateKoreanAnalyses(word: string): KoreanAnalysis[] {
  const trimmed = word.trim();
  const map = new Map<string, KoreanAnalysis>();
  if (!trimmed) return [];

  const record = (lemma: string, suffix: string, steps: GrammarStep[]) => {
    if (!lemma || lemma === trimmed) return;
    if (!map.has(lemma)) {
      map.set(lemma, { lemma, suffix, steps });
    }
  };

  // 1. Longest-first particle stripping (noun stems)
  for (const rule of KOREAN_PARTICLE_RULES) {
    if (trimmed.endsWith(rule.suf) && trimmed.length > rule.suf.length) {
      const stem = trimmed.slice(0, -rule.suf.length);
      const steps = rule.steps || [{ suffix: rule.suf, meaning: rule.meaning, kind: rule.kind }];
      record(stem, rule.suf, steps);
    }
  }

  // 2. Formal polite -ㅂ니다 / -ㅂ니까 (coda ㅂ = 17 on char before 니다/니까)
  if ((trimmed.endsWith('니다') || trimmed.endsWith('니까')) && trimmed.length >= 3) {
    const before = trimmed.slice(0, -2);
    const strippedB = stripHangulCoda(before.slice(-1), 17);
    if (strippedB) {
      const stem = before.slice(0, -1) + strippedB;
      const isQ = trimmed.endsWith('니까');
      const meaning = isQ ? 'formal polite question' : 'formal polite';
      const suf = isQ ? 'ㅂ니까' : 'ㅂ니다';
      record(`${stem}다`, suf, [{ suffix: suf, meaning, kind: 'ending' }]);
      record(`${stem}하다`, suf, [{ suffix: suf, meaning, kind: 'ending' }]);
    }
  }

  // 3. Adjective/verb -ㄴ/-ㄹ modifier endings (e.g. 중요한 -> 중요하다, 예쁜 -> 예쁘다, 갈 -> 가다)
  if (trimmed.length >= 1) {
    const last = trimmed.slice(-1);
    const prefix = trimmed.slice(0, -1);
    const strippedN = stripHangulCoda(last, 4); // ㄴ
    if (strippedN) {
      record(
        `${prefix}${strippedN}다`,
        'ㄴ',
        [{ suffix: 'ㄴ', meaning: 'attributive modifier form (modifies following noun)', kind: 'ending' }]
      );
      // ㅂ irregular adjectives (아름다운 -> 아름답다, 어려운 -> 어렵다)
      if (strippedN === '우' && prefix.length >= 1) {
        const pParts = getHangulParts(prefix.slice(-1));
        if (pParts && pParts.jong === 0) {
          record(
            `${prefix.slice(0, -1)}${composeHangul(pParts.cho, pParts.jung, 17)}다`,
            'ㄴ',
            [{ suffix: 'ㄴ', meaning: 'attributive modifier form (modifies following noun)', kind: 'ending' }]
          );
        }
      }
    }
    const strippedL = stripHangulCoda(last, 8); // ㄹ
    if (strippedL) {
      record(`${prefix}${strippedL}다`, 'ㄹ', [{ suffix: 'ㄹ', meaning: 'future modifier', kind: 'ending' }]);
    }
  }

  // 3b. Noun + 하다 / 되다 light verbs (공부하다, 공부했어요 -> 공부하다 & 공부)
  const lv = parseKoreanLightVerb(trimmed);
  if (lv && !lv.tail.isAttributiveModifier) {
    const lvLabel =
      lv.tail.verb === '하다'
        ? '+ 하다 (to do — verb form)'
        : '+ 되다 (to become — verb form)';
    const lvSteps: GrammarStep[] = [
      { suffix: lv.tail.verb, meaning: lvLabel, kind: 'ending' },
      ...(lv.tail.extraSteps || []),
    ];
    record(`${lv.nounStem}${lv.tail.verb}`, lv.tail.suf, lvSteps);
    record(lv.nounStem, lv.tail.suf, lvSteps);
  }

  // 4. Longest-first verb/adjective ending stripping
  for (const rule of KOREAN_VERB_ENDING_RULES) {
    if (trimmed.endsWith(rule.suf) && trimmed.length > rule.suf.length) {
      const stem = trimmed.slice(0, -rule.suf.length);
      const steps = rule.steps || [{ suffix: rule.suf, meaning: rule.meaning, kind: rule.kind }];
      record(stem, rule.suf, steps);
      addKoreanVerbStemVariants(stem, steps, rule.suf, record);
    }
  }

  return Array.from(map.values());
}

export function generateKoreanCandidates(word: string): string[] {
  return generateKoreanAnalyses(word).map((a) => a.lemma);
}

// ---------------------------------------------------------------------------
// Grammar Explanation Classifiers Across Languages (KO, TR, ES, DE, FR, IT, PT, NL)
// ---------------------------------------------------------------------------

export function classifyEuropeanInflection(
  langId: string,
  surface: string,
  lemma: string,
  lemmaPos: string[] = []
): { grammarSuffix?: string; grammarMeaning?: string; grammarSteps?: GrammarStep[] } {
  const cleanSurface = surface
    .trim()
    .replace(/^(dell|all|dall|nell|sull|coll|jusqu|lorsqu|puisqu|quoiqu|un|qu|gl|l|d|j|c|s|n|m|t)['’]/i, '');
  const lowerSurface = cleanSurface.toLowerCase();
  const lowerLemma = lemma.trim().toLowerCase();
  if (!lowerSurface || !lowerLemma || lowerSurface === lowerLemma) {
    return {};
  }

  // Common-prefix suffix extraction
  let prefixLen = 0;
  const maxPrefix = Math.min(lowerSurface.length, lowerLemma.length);
  while (prefixLen < maxPrefix && lowerSurface[prefixLen] === lowerLemma[prefixLen]) {
    prefixLen++;
  }
  const rawSuffix = lowerSurface.slice(prefixLen) || lowerSurface;
  let grammarSuffix = `-${rawSuffix}`;
  let grammarMeaning: string | undefined;
  const posText = lemmaPos.join(' ').toLowerCase();
  const isAdj = /\badj/i.test(posText);
  const isVerb = /verb/.test(posText) || (!isAdj && (
    (langId === 'es' && /(ar|er|ir)$/.test(lowerLemma)) ||
    (langId === 'pt' && /(ar|er|ir|or)$/.test(lowerLemma)) ||
    (langId === 'fr' && /(er|ir|re)$/.test(lowerLemma)) ||
    (langId === 'it' && /(are|ere|ire)$/.test(lowerLemma)) ||
    ((langId === 'de' || langId === 'nl') && /en$/.test(lowerLemma))
  ));

  if (isAdj && !isVerb) {
    grammarMeaning = 'inflected adjective form (gender / number / case)';
  } else if (langId === 'es') {
    if (/(ando|iendo|yendo)$/.test(lowerSurface)) grammarMeaning = 'gerund (-ing)';
    else if (/(ábamos|íamos|ábais|íais)$/.test(lowerSurface)) grammarMeaning = '1st-person plural imperfect';
    else if (/(ábamos|íamos|amos|emos|imos)$/.test(lowerSurface)) grammarMeaning = '1st-person plural (we)';
    else if (/(ado|ido|ada|ida|ados|idos|adas|idas)$/.test(lowerSurface)) grammarMeaning = 'past participle';
    else if (/(aba|abas|aban|ía|ías|ían)$/.test(lowerSurface)) grammarMeaning = 'imperfect past';
    else if (/(aron|ieron|aste|iste|ó|é|í)$/.test(lowerSurface)) grammarMeaning = 'preterite past';
    else if (/(aré|eré|iré|ará|erá|irá|arán|erán|irán)$/.test(lowerSurface)) grammarMeaning = 'future tense';
    else if (/(aría|ería|iría|arían|erían|irían)$/.test(lowerSurface)) grammarMeaning = 'conditional';
    else if (isVerb && /o$/.test(lowerSurface)) grammarMeaning = '1st-person singular (I)';
    else if (isVerb && /(an|en)$/.test(lowerSurface)) grammarMeaning = '3rd-person plural (they)';
    else if (isVerb && /(as|es)$/.test(lowerSurface)) grammarMeaning = '2nd-person singular (you)';
    else if (/(es|s)$/.test(lowerSurface)) grammarMeaning = 'plural / inflected form';
  } else if (langId === 'pt') {
    if (/(ando|endo|indo|ondo)$/.test(lowerSurface)) grammarMeaning = 'gerund (-ing)';
    else if (/(ávamos|íamos)$/.test(lowerSurface)) grammarMeaning = '1st-person plural imperfect';
    else if (/(amos|emos|imos)$/.test(lowerSurface)) grammarMeaning = '1st-person plural (we)';
    else if (/(ado|ido|ada|ida|ados|idos|adas|idas)$/.test(lowerSurface)) grammarMeaning = 'past participle';
    else if (/(ava|avas|avam|ia|ias|iam)$/.test(lowerSurface)) grammarMeaning = 'imperfect past';
    else if (/(aram|eram|iram|ou|eu|iu)$/.test(lowerSurface)) grammarMeaning = 'preterite past';
    else if (isVerb && /o$/.test(lowerSurface)) grammarMeaning = '1st-person singular (I)';
    else if (isVerb && /(am|em)$/.test(lowerSurface)) grammarMeaning = '3rd-person plural (they)';
    else if (/(ões|ães|ais|es|s)$/.test(lowerSurface)) grammarMeaning = 'plural / inflected form';
  } else if (langId === 'fr') {
    if (/ant$/.test(lowerSurface)) grammarMeaning = 'present participle (-ing)';
    else if (/(ais|ait|aient)$/.test(lowerSurface)) grammarMeaning = 'imperfect past';
    else if (/(ions|iez)$/.test(lowerSurface)) grammarMeaning = 'imperfect plural';
    else if (/ez$/.test(lowerSurface)) grammarMeaning = 'plural verb form (vous)';
    else if (/ons$/.test(lowerSurface)) grammarMeaning = 'plural verb form (nous)';
    else if (/(é|ée|és|ées)$/.test(lowerSurface)) grammarMeaning = 'past participle';
    else if (isVerb && /ent$/.test(lowerSurface)) grammarMeaning = '3rd-person plural (they)';
    else if (/(s|x|es)$/.test(lowerSurface)) grammarMeaning = 'plural / inflected form';
  } else if (langId === 'it') {
    if (/(ando|endo)$/.test(lowerSurface)) grammarMeaning = 'gerund (-ing)';
    else if (/(ato|ito|uto|ata|ita|uta|ati|iti|uti)$/.test(lowerSurface)) grammarMeaning = 'past participle';
    else if (/iamo$/.test(lowerSurface)) grammarMeaning = '1st-person plural (we)';
    else if (/(ava|avo|avi|avano|eva|evo|evi|evano|iva|ivo|ivi|ivano)$/.test(lowerSurface)) grammarMeaning = 'imperfect past';
    else if (isVerb && /(ano|ono)$/.test(lowerSurface)) grammarMeaning = '3rd-person plural (they)';
    else if (isVerb && /(ate|ete|ite)$/.test(lowerSurface)) grammarMeaning = '2nd-person plural / past participle';
    else if (/(i|e)$/.test(lowerSurface)) grammarMeaning = 'plural / inflected form';
  } else if (langId === 'de') {
    if (/^ge.+(t|en)$/.test(lowerSurface) && !lowerLemma.startsWith('ge')) {
      grammarSuffix = lowerSurface.endsWith('en') ? 'ge-...-en' : 'ge-...-t';
      grammarMeaning = 'past participle';
    } else if (/(te|ten|test|tet)$/.test(lowerSurface)) {
      grammarMeaning = 'past tense';
    } else if (isVerb && /st$/.test(lowerSurface)) {
      grammarMeaning = '2nd-person singular (du)';
    } else if (isVerb && /t$/.test(lowerSurface)) {
      grammarMeaning = '3rd-person singular / plural';
    } else if (/(en|er|es|em|e|n|s)$/.test(lowerSurface)) {
      grammarMeaning = 'inflected / plural / case form';
    }
  } else if (langId === 'nl') {
    if (/^ge.+(d|t|en)$/.test(lowerSurface) && !lowerLemma.startsWith('ge')) {
      grammarSuffix = lowerSurface.endsWith('en') ? 'ge-...-en' : lowerSurface.endsWith('d') ? 'ge-...-d' : 'ge-...-t';
      grammarMeaning = 'past participle';
    } else if (/(de|te|den|ten)$/.test(lowerSurface)) {
      grammarMeaning = 'past tense';
    } else if (/end(e)?$/.test(lowerSurface)) {
      grammarMeaning = 'present participle (-ing)';
    } else if (/(en|s|e|t)$/.test(lowerSurface)) {
      grammarMeaning = 'inflected / plural verb or noun form';
    }
  }

  const finalMeaning = grammarMeaning || 'inflected form';
  return {
    grammarSuffix,
    grammarMeaning: finalMeaning,
    grammarSteps: [{ suffix: grammarSuffix.replace(/^-/, ''), meaning: finalMeaning }],
  };
}

export function explainMultilingualInflection(
  langId: string,
  surface: string,
  entry: Pick<DictionaryEntry, 'word' | 'meanings' | 'partsOfSpeech'>
): {
  grammarSuffix?: string;
  grammarMeaning?: string;
  grammarSteps?: GrammarStep[];
  grammarComponents?: GrammarComponent[];
} {
  const clean = surface.trim();
  const lemma = entry.word.trim();
  if (!clean || !lemma) {
    return {};
  }

  // Korean light-verb (하다 / 되다) recognition applies even when `clean === lemma` (e.g. 공부하다)
  if (langId === 'ko') {
    const lv = parseKoreanLightVerb(clean);
    if (lv && !lv.tail.isAttributiveModifier && (lemma === `${lv.nounStem}${lv.tail.verb}` || lemma === lv.nounStem)) {
      const lvLabel =
        lv.tail.verb === '하다'
          ? '+ 하다 (to do — verb form)'
          : '+ 되다 (to become — verb form)';
      const extraText = lv.tail.extraSteps?.map((s) => s.meaning).join(' + ');
      const grammarMeaning = extraText ? `${lvLabel} · ${extraText}` : lvLabel;
      const steps: GrammarStep[] = [
        { suffix: lv.tail.verb, meaning: lvLabel, kind: 'ending' },
        ...(lv.tail.extraSteps || []),
      ];
      const grammarComponents: GrammarComponent[] = [
        {
          surface: lv.nounStem,
          basic: lv.nounStem,
          pos: 'Noun',
          meaning: lemma === lv.nounStem ? entry.meanings[0] || lv.nounStem : entry.meanings[0] || lv.nounStem,
        },
        {
          surface: lv.tail.suf,
          basic: lv.tail.verb,
          pos: lv.tail.verb === '하다' ? 'Light Verb (하다)' : 'Light Verb (되다)',
          meaning:
            lv.tail.verb === '하다'
              ? extraText
                ? `to do — turns noun into a verb (${extraText})`
                : 'to do — turns noun into a verb'
              : extraText
              ? `to become — turns noun into a verb (${extraText})`
              : 'to become — turns noun into a verb',
        },
      ];
      return {
        grammarSuffix: `-${lv.tail.suf}`,
        grammarMeaning,
        grammarSteps: steps,
        grammarComponents,
      };
    }

    if (clean.toLowerCase() === lemma.toLowerCase()) {
      return {};
    }

    const analyses = generateKoreanAnalyses(clean);
    const matched = analyses.find((a) => a.lemma === lemma) || analyses[0];
    if (matched) {
      const grammarSuffix = matched.suffix ? `-${matched.suffix}` : undefined;
      const grammarMeaning = matched.steps.map((s) => s.meaning).join(' + ');
      const stemSurface =
        matched.suffix && clean.endsWith(matched.suffix)
          ? clean.slice(0, -matched.suffix.length)
          : clean;
      const grammarComponents: GrammarComponent[] = [
        {
          surface: stemSurface || lemma,
          basic: lemma,
          pos: entry.partsOfSpeech[0] || 'Root',
          meaning: entry.meanings[0] || lemma,
        },
        ...matched.steps.map((st) => ({
          surface: st.suffix,
          basic: st.suffix,
          pos: st.kind === 'particle' ? 'Particle' : 'Ending',
          meaning: st.meaning,
        })),
      ];
      return {
        grammarSuffix,
        grammarMeaning: grammarMeaning || 'inflected form',
        grammarSteps: matched.steps,
        grammarComponents: grammarComponents.length > 1 ? grammarComponents : undefined,
      };
    }
  }

  if (clean.toLowerCase() === lemma.toLowerCase()) {
    return {};
  }

  if (langId === 'tr') {
    const analyses = generateTurkishAnalyses(clean);
    const matched =
      analyses.find((a) => a.lemma.toLocaleLowerCase('tr-TR') === lemma.toLocaleLowerCase('tr-TR')) ||
      analyses[0];
    if (matched && matched.steps.length > 0) {
      const combinedSuffix = matched.steps.map((s) => s.suffix).join('');
      const grammarSuffix = combinedSuffix ? `-${combinedSuffix}` : undefined;
      const grammarMeaning = matched.steps.map((s) => s.meaning).join(' + ');
      const stemSurface =
        combinedSuffix && clean.toLocaleLowerCase('tr-TR').endsWith(combinedSuffix)
          ? clean.slice(0, clean.length - combinedSuffix.length)
          : lemma;
      const grammarComponents: GrammarComponent[] = [
        {
          surface: stemSurface || lemma,
          basic: lemma,
          pos: entry.partsOfSpeech[0] || 'Root',
          meaning: entry.meanings[0] || lemma,
        },
        ...matched.steps.map((st) => ({
          surface: `-${st.suffix}`,
          basic: st.suffix,
          pos: 'Suffix',
          meaning: st.meaning,
        })),
      ];
      return {
        grammarSuffix,
        grammarMeaning,
        grammarSteps: matched.steps,
        grammarComponents: grammarComponents.length > 1 ? grammarComponents : undefined,
      };
    }
  }

  if (['es', 'de', 'fr', 'it', 'pt', 'nl'].includes(langId)) {
    return classifyEuropeanInflection(langId, clean, lemma, entry.partsOfSpeech);
  }

  return {};
}

export function generateLookupCandidates(langId: string, word: string, lemma?: string): string[] {
  const candidates = new Set<string>();
  const inputs = [word, lemma].filter((v): v is string => Boolean(v && v.trim()));

  for (const input of inputs) {
    const clean = input.trim();
    if (isBareElisionPrefix(langId, clean)) continue;
    candidates.add(clean);
    candidates.add(clean.toLowerCase());

    if (langId === 'de') {
      for (const c of generateGermanCandidates(clean)) candidates.add(c);
    } else if (langId === 'es' || langId === 'fr' || langId === 'it' || langId === 'pt' || langId === 'nl') {
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

interface StarterIndex {
  exactMap: Map<string, StarterLexiconEntry>;
  aliasMap: Map<string, StarterLexiconEntry[]>;
}

const STARTER_INDEX_CACHE = new Map<string, StarterIndex>();

function getStarterIndex(langId: string): StarterIndex {
  let idx = STARTER_INDEX_CACHE.get(langId);
  if (!idx) {
    const exactMap = new Map<string, StarterLexiconEntry>();
    const aliasMap = new Map<string, StarterLexiconEntry[]>();
    const list = STARTER_LEXICONS[langId] || [];
    for (const entry of list) {
      const w = entry.word.trim();
      if (w) {
        if (!exactMap.has(w)) exactMap.set(w, entry);
        const wLower = w.toLowerCase();
        if (!exactMap.has(wLower)) exactMap.set(wLower, entry);
      }
      for (const a of entry.aliases || []) {
        const cleanAlias = a.trim();
        if (!cleanAlias) continue;
        for (const k of [cleanAlias, cleanAlias.toLowerCase()]) {
          const arr = aliasMap.get(k) || [];
          if (!arr.includes(entry)) arr.push(entry);
          aliasMap.set(k, arr);
        }
      }
    }
    idx = { exactMap, aliasMap };
    STARTER_INDEX_CACHE.set(langId, idx);
  }
  return idx;
}

export function findStarterEntry(langId: string, word: string, lemma?: string): StarterLexiconEntry | null {
  const cleanWord = word.trim();
  if (!cleanWord || isBareElisionPrefix(langId, cleanWord)) return null;

  const { exactMap, aliasMap } = getStarterIndex(langId);
  const lower = cleanWord.toLowerCase();

  // Tier 1: exact match
  const exact = exactMap.get(cleanWord) || exactMap.get(lower);
  if (exact) return exact;

  // Tier 2: starter alias/form match
  const aliasHits = aliasMap.get(cleanWord) || aliasMap.get(lower);
  if (aliasHits && aliasHits.length > 0) return aliasHits[0];

  // Tier 3: language-specific morphological candidates
  const candidates = generateLookupCandidates(langId, cleanWord, lemma);
  for (const c of candidates) {
    const hit = exactMap.get(c) || exactMap.get(c.toLowerCase()) || aliasMap.get(c)?.[0];
    if (hit) return hit;
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

async function findExactDbEntries(langId: string, terms: string[]): Promise<JmdictEntryItem[]> {
  if (terms.length === 0) return [];
  const uniq = Array.from(new Set(terms.flatMap((t) => [t, t.toLowerCase()]).filter(Boolean)));
  if (uniq.length === 0) return [];
  try {
    const raw = await db.jmdictEntries
      .where('forms')
      .anyOf(uniq)
      .filter((r) => r.languageCode === langId && !r.kinds?.includes('sentences'))
      .toArray();
    const targetLowerSet = new Set(uniq.map((u) => u.toLowerCase()));
    return raw.filter((r) => {
      if (targetLowerSet.has(r.primaryWord.toLowerCase())) return true;
      return (r.kanji || []).some((k) => targetLowerSet.has(k.text.toLowerCase()));
    });
  } catch {
    return [];
  }
}

async function findDbExamplesForTerms(langId: string, terms: string[]): Promise<ExampleSentence[]> {
  const uniq = Array.from(new Set(terms.flatMap((t) => [t.trim(), t.trim().toLowerCase()]).filter(Boolean)));
  if (uniq.length === 0) return [];
  try {
    const rows = await db.jmdictEntries
      .where('forms')
      .anyOf(uniq)
      .filter((r) => r.languageCode === langId && Boolean(r.kinds?.includes('sentences')))
      .limit(12)
      .toArray();
    const seen = new Set<string>();
    const out: ExampleSentence[] = [];
    for (const r of rows) {
      const original = r.primaryWord?.trim();
      const translation = r.senses?.[0]?.glosses?.[0]?.trim() || '';
      if (!original || !translation || seen.has(original)) continue;
      seen.add(original);
      out.push({
        original,
        translation,
        reading: r.primaryReading || undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function attachExamplesToEntry(entry: DictionaryEntry, dbExamples: ExampleSentence[]): DictionaryEntry {
  if (dbExamples.length === 0) return entry;
  const merged = [...(entry.examples || [])];
  const seen = new Set(merged.map((e) => e.original));
  for (const ex of dbExamples) {
    if (!seen.has(ex.original)) {
      seen.add(ex.original);
      merged.push(ex);
    }
  }
  return { ...entry, examples: merged };
}

async function resolveLemmaEntries(
  langId: string,
  lemmas: string[]
): Promise<DictionaryEntry[]> {
  if (lemmas.length === 0) return [];
  const out: DictionaryEntry[] = [];
  const seenWords = new Set<string>();

  const dbMatches = await findExactDbEntries(langId, lemmas);
  dbMatches.sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));
  for (const m of dbMatches) {
    const key = m.primaryWord.toLowerCase();
    if (!seenWords.has(key)) {
      seenWords.add(key);
      out.push(dbEntryToDictionaryEntry(langId, m));
    }
  }

  const { exactMap } = getStarterIndex(langId);
  for (const l of lemmas) {
    const key = l.toLowerCase();
    if (seenWords.has(key)) continue;
    const starter = exactMap.get(l) || exactMap.get(key);
    if (starter) {
      seenWords.add(starter.word.toLowerCase());
      out.push(starterEntryToDictionaryEntry(langId, starter));
    }
  }

  return out;
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
      if (config.id === 'zh') {
        const dict = await getMandarinLexiconCache();
        return tokenizeMultilingualText('zh', text, dict);
      }
      return tokenizeMultilingualText(config.id, text);
    },

    async lookup(word: string, lemma?: string): Promise<DictionaryEntry | null> {
      const clean = word.trim();
      if (!clean || isBareElisionPrefix(config.id, clean)) {
        return null;
      }

      // Protect Mandarin standalone attributive particle 的
      if (config.id === 'zh' && clean === '的') {
        return {
          id: 'zh-grammar-de',
          word: '的',
          readings: ['de'],
          meanings: ["attributive modifier particle ('s / -al)"],
          partsOfSpeech: ['Grammar Particle'],
          level: 'HSK 1',
          frequencyRank: 1,
          furiganaSegments: [{ text: '的', ruby: 'de' }],
          isSampleFallback: false,
          sourceKind: 'dictionary',
        };
      }

      const lower = clean.toLowerCase();
      const { exactMap, aliasMap } = getStarterIndex(config.id);

      // -----------------------------------------------------------------
      // Tier 1: Exact Dictionary Entry Match (IndexedDB + Starter)
      // -----------------------------------------------------------------
      const exactTerms = lemma && lemma.trim() && lemma.trim().toLowerCase() !== lower
        ? [clean]
        : [clean];
      const exactDbMatches = await findExactDbEntries(config.id, exactTerms);
      exactDbMatches.sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));

      const exactStarter = exactMap.get(clean) || exactMap.get(lower);

      // -----------------------------------------------------------------
      // Tier 2: O(1) Pack `forms` Inflection-to-Lemma Lookup (+ Starter Aliases)
      // -----------------------------------------------------------------
      const formLemmas = new Set<string>();
      try {
        const formRow = await db.packForms.get([config.id, lower]);
        if (formRow) {
          for (const l of formRow.lemmas) {
            if (l.trim()) formLemmas.add(l.trim());
          }
        }
      } catch {
        // Ignore if packForms unavailable
      }
      // Also check starter aliases for Tier 2
      for (const sEntry of aliasMap.get(clean) || aliasMap.get(lower) || []) {
        formLemmas.add(sEntry.word);
      }

      // Remove self-lemma from `formOf` if identical to exact headword
      const hasTier1 = exactDbMatches.length > 0 || Boolean(exactStarter);
      if (hasTier1) {
        let primary: DictionaryEntry =
          exactDbMatches.length > 0
            ? dbEntryToDictionaryEntry(config.id, exactDbMatches[0])
            : starterEntryToDictionaryEntry(config.id, exactStarter!);

        // Enrich Korean light-verb compounds (공부하다) with grammarMeaning & 2-part Breakdown
        if (config.id === 'ko') {
          const koLvInfo = explainMultilingualInflection('ko', clean, primary);
          if (koLvInfo.grammarMeaning) {
            primary = {
              ...primary,
              grammarSuffix: koLvInfo.grammarSuffix,
              grammarMeaning: koLvInfo.grammarMeaning,
              grammarSteps: koLvInfo.grammarSteps,
              grammarComponents: koLvInfo.grammarComponents || primary.grammarComponents,
            };
          }
        }

        const allEntries =
          exactDbMatches.length > 0
            ? exactDbMatches.map((m) => dbEntryToDictionaryEntry(config.id, m))
            : [primary];

        const distinctLemmas = Array.from(formLemmas).filter(
          (l) => l.toLowerCase() !== primary.word.toLowerCase()
        );
        if (distinctLemmas.length > 0) {
          const resolvedFormEntries = await resolveLemmaEntries(config.id, distinctLemmas);
          primary.formOf = distinctLemmas.map((l) => {
            const matchedEntry =
              resolvedFormEntries.find((e) => e.word.toLowerCase() === l.toLowerCase()) ||
              resolvedFormEntries[0];
            const info = explainMultilingualInflection(
              config.id,
              clean,
              matchedEntry || { word: l, meanings: [], partsOfSpeech: [] }
            );
            return {
              lemma: l,
              entry: matchedEntry,
              grammarSuffix: info.grammarSuffix,
              grammarMeaning: info.grammarMeaning,
            };
          });
        }

        const dbExamples = await findDbExamplesForTerms(config.id, [clean, primary.word]);
        return attachExamplesToEntry(
          {
            ...primary,
            allEntries,
          },
          dbExamples
        );
      }

      // If Tier 1 missed, resolve Tier 2 (`forms`) lemmas cleanly!
      if (formLemmas.size > 0) {
        const formLemmaList = Array.from(formLemmas);
        const resolved = await resolveLemmaEntries(config.id, formLemmaList);
        if (resolved.length > 0) {
          const enrich = (r: DictionaryEntry): DictionaryEntry => {
            const isInflected = clean.toLowerCase() !== r.word.toLowerCase();
            const info = isInflected ? explainMultilingualInflection(config.id, clean, r) : {};
            return {
              ...r,
              conjugatedForm: isInflected ? clean : undefined,
              inflectedSurface: isInflected ? clean : undefined,
              grammarSuffix: info.grammarSuffix,
              grammarMeaning: info.grammarMeaning,
              grammarSteps: info.grammarSteps,
              grammarComponents: info.grammarComponents || r.grammarComponents,
            };
          };
          const enriched = resolved.map(enrich);
          const dbExamples = await findDbExamplesForTerms(config.id, [clean, enriched[0].word]);
          return attachExamplesToEntry(
            {
              ...enriched[0],
              allEntries: enriched,
            },
            dbExamples
          );
        }
      }

      // Check passed `lemma` argument directly if provided and distinct
      if (lemma && lemma.trim() && lemma.trim().toLowerCase() !== lower) {
        const lemmaResolved = await resolveLemmaEntries(config.id, [lemma.trim()]);
        if (lemmaResolved.length > 0) {
          const info = explainMultilingualInflection(config.id, clean, lemmaResolved[0]);
          const dbExamples = await findDbExamplesForTerms(config.id, [clean, lemmaResolved[0].word]);
          return attachExamplesToEntry(
            {
              ...lemmaResolved[0],
              conjugatedForm: clean,
              inflectedSurface: clean,
              grammarSuffix: info.grammarSuffix,
              grammarMeaning: info.grammarMeaning,
              grammarSteps: info.grammarSteps,
              grammarComponents: info.grammarComponents || lemmaResolved[0].grammarComponents,
              allEntries: lemmaResolved,
            },
            dbExamples
          );
        }
      }

      // -----------------------------------------------------------------
      // Tier 3: Conservative Morphological / Vowel-Harmony / Stem Fallback
      // -----------------------------------------------------------------
      const stemCandidates = generateLookupCandidates(config.id, clean, lemma).filter(
        (c) => c.toLowerCase() !== lower
      );

      if (stemCandidates.length > 0) {
        try {
          const stemMatches = await db.jmdictEntries
            .where('forms')
            .anyOf(stemCandidates)
            .filter((r) => r.languageCode === config.id && !r.kinds?.includes('sentences'))
            .toArray();

          if (stemMatches.length > 0) {
            // For Turkish, prefer longest valid dictionary root; otherwise priorityScore
            stemMatches.sort((a, b) => {
              if (config.id === 'tr' && a.primaryWord.length !== b.primaryWord.length) {
                return b.primaryWord.length - a.primaryWord.length;
              }
              return (b.priorityScore || 0) - (a.priorityScore || 0);
            });
            const converted = stemMatches.map((m) => {
              const base = dbEntryToDictionaryEntry(config.id, m);
              const isInflected = clean.toLowerCase() !== m.primaryWord.toLowerCase();
              const info = isInflected ? explainMultilingualInflection(config.id, clean, base) : {};
              return {
                ...base,
                conjugatedForm: isInflected ? clean : undefined,
                inflectedSurface: isInflected ? clean : undefined,
                grammarSuffix: info.grammarSuffix,
                grammarMeaning: info.grammarMeaning,
                grammarSteps: info.grammarSteps,
                grammarComponents: info.grammarComponents || base.grammarComponents,
              };
            });
            const dbExamples = await findDbExamplesForTerms(config.id, [clean, converted[0].word]);
            return attachExamplesToEntry(
              {
                ...converted[0],
                allEntries: converted,
              },
              dbExamples
            );
          }
        } catch {
          // Ignore DB error and check starter
        }

        // Starter stem fallback (prefer longest root for Turkish)
        const starterHits: StarterLexiconEntry[] = [];
        for (const c of stemCandidates) {
          const s = exactMap.get(c) || exactMap.get(c.toLowerCase()) || aliasMap.get(c)?.[0];
          if (s && !starterHits.includes(s)) starterHits.push(s);
        }
        if (starterHits.length > 0) {
          if (config.id === 'tr') {
            starterHits.sort((a, b) => b.word.length - a.word.length);
          }
          const base = starterEntryToDictionaryEntry(config.id, starterHits[0]);
          const isInflected = clean.toLowerCase() !== starterHits[0].word.toLowerCase();
          const info = isInflected ? explainMultilingualInflection(config.id, clean, base) : {};
          const primary: DictionaryEntry = {
            ...base,
            conjugatedForm: isInflected ? clean : undefined,
            inflectedSurface: isInflected ? clean : undefined,
            grammarSuffix: info.grammarSuffix,
            grammarMeaning: info.grammarMeaning,
            grammarSteps: info.grammarSteps,
            grammarComponents: info.grammarComponents || base.grammarComponents,
          };
          const dbExamples = await findDbExamplesForTerms(config.id, [clean, primary.word]);
          return attachExamplesToEntry(primary, dbExamples);
        }
      }

      // 4. Mandarin character fallback: build pinyin even for unindexed Hanzi compounds
      if (config.id === 'zh' && HANZI_REGEX.test(clean)) {
        const pyInfo = buildMandarinPinyinSegments(clean);
        return {
          id: `zh-pinyin-${clean}`,
          word: clean,
          readings: pyInfo.reading ? [pyInfo.reading] : [],
          meanings: [`No dictionary entry found for "${clean}".`],
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
