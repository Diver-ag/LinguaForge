import type { Token } from '../../core/languagePack';
import { JAPANESE_DICTIONARY_SAMPLE } from './dictionaryData';
import { katakanaToHiragana, buildFurigana } from './kanaUtils';

// Map of common kana/romaji conversions for readings
const HIRAGANA_TO_ROMAJI: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', を: 'wo', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi',ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  っ: '',
};

export function hiraganaToRomaji(kana: string): string {
  let result = '';
  let i = 0;
  while (i < kana.length) {
    const char = kana[i];
    result += HIRAGANA_TO_ROMAJI[char] || char;
    i++;
  }
  return result;
}

export { katakanaToHiragana, buildFurigana };

// Fast dictionary lookup map
const dictMap = new Map<string, typeof JAPANESE_DICTIONARY_SAMPLE[0]>();
for (const entry of JAPANESE_DICTIONARY_SAMPLE) {
  dictMap.set(entry.word, entry);
}

// In-memory per-document token cache
const documentTokenCache = new Map<string, Token[]>();

// Tokenizer diagnostics interface
export interface TokenizerDiagnosticsInfo {
  workerCreated: boolean;
  dictionaryBaseUrl: string;
  files: Record<string, { status: number | string; ok: boolean; size?: number }>;
  initError: { message: string; stack?: string } | null;
  isReady: boolean;
  isLoading: boolean;
}

// Status tracking for tokenizer
let workerCreated = false;
let isReady = false;
let isLoading = false;
let lastInitError: { message: string; stack?: string } | null = null;
let tokenizerWarning: string | null = null;

export function getTokenizerWarning(): string | null {
  if (lastInitError) {
    return `Kuromoji error: ${lastInitError.message}`;
  }
  return tokenizerWarning;
}

export function getTokenizerStatus(): {
  isReady: boolean;
  isLoading: boolean;
  workerCreated: boolean;
  error: { message: string; stack?: string } | null;
  warning: string | null;
} {
  return {
    isReady,
    isLoading,
    workerCreated,
    error: lastInitError,
    warning: tokenizerWarning,
  };
}

// Local bundled dictionary path with trailing slash
export const DEFAULT_DIC_PATH = '/dict/';

// Web Worker instance and lifecycle state
let workerInstance: Worker | null = null;
let readyPromise: Promise<void> | null = null;
let messageSeq = 0;
const pendingCallbacks = new Map<
  string,
  {
    resolve: (tokens: Token[]) => void;
    reject: (err: any) => void;
  }
>();

export function initWorker(dicPath = DEFAULT_DIC_PATH): Promise<void> {
  if (isReady) return Promise.resolve();
  if (readyPromise) return readyPromise;
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return Promise.reject(new Error('Web Workers not supported in current environment'));
  }

  isLoading = true;
  lastInitError = null;
  tokenizerWarning = null;

  readyPromise = new Promise<void>((resolve, reject) => {
    let initTimer: any = null;

    const cleanupInitTimer = () => {
      if (initTimer) {
        clearTimeout(initTimer);
        initTimer = null;
      }
    };

    try {
      workerInstance = new Worker(new URL('./tokenizer.worker.ts', import.meta.url), {
        type: 'module',
      });
      workerCreated = true;

      // Generous timeout for downloading dictionary files and initializing Kuromoji
      initTimer = setTimeout(() => {
        cleanupInitTimer();
        readyPromise = null;
        isLoading = false;
        lastInitError = { message: 'Kuromoji initialization timed out after 30s' };
        tokenizerWarning = lastInitError.message;
        reject(new Error(lastInitError.message));
      }, 30000);

      workerInstance.onmessage = (e: MessageEvent) => {
        const data = e.data || {};
        if (data.type === 'ready') {
          cleanupInitTimer();
          isReady = true;
          isLoading = false;
          lastInitError = null;
          tokenizerWarning = null;
          resolve();
          return;
        }

        if (data.type === 'init_error') {
          cleanupInitTimer();
          readyPromise = null;
          isReady = false;
          isLoading = false;
          lastInitError = {
            message: data.error || 'Failed to initialize Kuromoji dictionary',
            stack: data.stack || '',
          };
          tokenizerWarning = `Kuromoji failed: ${lastInitError.message}`;
          reject(new Error(lastInitError.message));
          return;
        }

        if (data.type === 'tokenized' || data.id) {
          const { id, success, tokens, error } = data;
          const cb = pendingCallbacks.get(id);
          if (cb) {
            pendingCallbacks.delete(id);
            if (success && Array.isArray(tokens)) {
              cb.resolve(tokens);
            } else {
              cb.reject(new Error(error || 'Worker tokenization failed'));
            }
          }
        }
      };

      workerInstance.onerror = (err) => {
        console.warn('Tokenizer worker error:', err);
        cleanupInitTimer();
        readyPromise = null;
        isReady = false;
        isLoading = false;
        lastInitError = {
          message: err.message || 'Worker script failed to execute',
          stack: (err as any).filename ? `${(err as any).filename}:${(err as any).lineno}` : '',
        };
        tokenizerWarning = `Worker error: ${lastInitError.message}`;
        reject(new Error(lastInitError.message));
      };

      // Send initial init message to load kuromoji dictionary from /dict/
      workerInstance.postMessage({
        type: 'init',
        dicPath,
      });
    } catch (err: any) {
      cleanupInitTimer();
      readyPromise = null;
      isReady = false;
      isLoading = false;
      lastInitError = {
        message: err?.message || String(err),
        stack: err?.stack || '',
      };
      tokenizerWarning = `Worker spawn error: ${lastInitError.message}`;
      reject(err);
    }
  });

  return readyPromise;
}

/**
 * Diagnostic runner for the Settings view.
 * Tests dictionary file fetches (base.dat.gz, check.dat.gz, tid.dat.gz) and worker status.
 */
export async function runTokenizerDiagnostics(
  dicPath = DEFAULT_DIC_PATH
): Promise<TokenizerDiagnosticsInfo> {
  const cleanDicPath = dicPath.endsWith('/') ? dicPath : `${dicPath}/`;
  const fileList = ['base.dat.gz', 'check.dat.gz', 'tid.dat.gz'];
  const fileResults: Record<string, { status: number | string; ok: boolean; size?: number }> = {};

  for (const filename of fileList) {
    const url = `${cleanDicPath}${filename}`;
    try {
      const resp = await fetch(url, { method: 'GET', cache: 'no-cache' });
      const contentLength = resp.headers.get('content-length');
      fileResults[filename] = {
        status: resp.status,
        ok: resp.ok,
        size: contentLength ? parseInt(contentLength, 10) : undefined,
      };
    } catch (err: any) {
      fileResults[filename] = {
        status: err?.message || 'NetworkError',
        ok: false,
      };
    }
  }

  // Ensure worker is started or attempt init if not yet ready
  if (!isReady && !readyPromise) {
    initWorker(cleanDicPath).catch(() => {});
  }

  return {
    workerCreated,
    dictionaryBaseUrl: cleanDicPath,
    files: fileResults,
    initError: lastInitError,
    isReady,
    isLoading,
  };
}

import { db, type JmdictEntryItem } from '../../db/db';
import {
  deinflectJapanese,
  explainJapaneseInflection,
  explainNaAdjectiveSuffix,
  explainSuruVerbSuffix,
  getJapaneseComponentMeaning,
  JA_DERIVATIONAL_SUFFIXES,
  JA_DERIVATIONAL_SUFFIX_GLOSSES,
  PROTECTED_JA_GRAMMAR_TOKENS,
  STANDALONE_SURU_DEKIRU,
} from './deinflector';
import type { GrammarComponent, GrammarStep } from '../../core/languagePack';

const JA_PUNCT_RE = /^[、。！？「」『』（）［］【】・…—\s\n\r\t.,!?"'()\[\]]+$/;
const JA_PARTICLES = new Set([
  'は', 'が', 'を', 'に', 'へ', 'と', 'の', 'も', 'から', 'まで', 'より', 'や', 'か', 'ね', 'よ', 'な',
  'って', 'ばかり', 'だけ', 'しか', 'ほど', 'くらい', 'など', 'でも', 'けど', 'けれど',
]);
const JA_COPULA_START_RE = /^(では|じゃ|だっ|だった|だろ|だろう|でし|でした|なら|です|ではない|じゃない)$/;
const JA_INFLECTION_FRAG_RE =
  /^(ます|まし|ませ|ません|ました|ませんでした|ましょう|まして|た|だ|ない|なか|なかっ|なかった|なく|なくて|ないで|ず|ぬ|ん|て|で|てい|でい|てる|でる|てた|でた|てお|でお|てし|でし|ちゃ|じゃ|い|いる|いりゃ|ある|あり|おく|おい|お|しまう|しまっ|しま|みる|み|くる|き|いく|いっ|られ|られる|られな|られなかっ|させ|させる|させら|れ|れる|せ|せる|たい|たかっ|たく|たくな|そう|そうだ|そうで|よう|ようだ|らしい|ば|れば|たら|だら|たり|だり|ながら|っ|く|かっ|かった|くな|くない|くなかっ|くなかった|べ|き|ぎ|し|ち|に|び|み|り|え|け|げ|せ|ね|め|べら|べられ|べた|べない|べまし|べよう)+$/;

function isKanjiPresent(str: string): boolean {
  return /[\u4e00-\u9faf\u3400-\u4dbf々]/.test(str);
}

function isPureMultiKanji(str: string): boolean {
  return /^[\u4e00-\u9faf\u3400-\u4dbf々]{2,}$/.test(str);
}

function chooseBestDeinflectionLemma(surface: string): {
  lemma: string;
  reasons: string[];
  grammarMeaning: string;
  steps: GrammarStep[];
  entry?: typeof JAPANESE_DICTIONARY_SAMPLE[0];
} {
  const standalone = STANDALONE_SURU_DEKIRU[surface];
  if (standalone) {
    return {
      lemma: standalone.lemma,
      reasons: standalone.reasons,
      grammarMeaning: standalone.meaning,
      steps: [
        {
          suffix: standalone.suffix.replace(/^-/, ''),
          meaning: standalone.meaning,
          kind: standalone.reasons[0],
        },
      ],
      entry: dictMap.get(standalone.lemma),
    };
  }

  const candidates = deinflectJapanese(surface);
  // Prefer known dictionary match with deepest/cleanest match
  let bestDictMatch: {
    lemma: string;
    reasons: string[];
    grammarMeaning: string;
    steps: GrammarStep[];
    entry: typeof JAPANESE_DICTIONARY_SAMPLE[0];
  } | null = null;
  for (const cand of candidates) {
    const entry = dictMap.get(cand.lemma);
    if (entry) {
      if (!bestDictMatch || cand.reasons.length > bestDictMatch.reasons.length) {
        bestDictMatch = {
          lemma: cand.lemma,
          reasons: cand.reasons,
          grammarMeaning: cand.grammarMeaning,
          steps: cand.steps,
          entry,
        };
      }
    }
  }
  if (bestDictMatch) return bestDictMatch;

  // Otherwise pick the candidate with reasons (preferring canonical verb/adj endings over bogus 〜す)
  const inflected = candidates.filter((c) => c.reasons.length > 0);
  if (inflected.length > 0) {
    inflected.sort((a, b) => {
      // Deprioritize bogus 2+-kanji godan 〜す stems when する exists
      const aBogusSu = /^[\u4e00-\u9faf\u3400-\u4dbf々]{2,}す$/.test(a.lemma) ? 1 : 0;
      const bBogusSu = /^[\u4e00-\u9faf\u3400-\u4dbf々]{2,}す$/.test(b.lemma) ? 1 : 0;
      if (aBogusSu !== bBogusSu) return aBogusSu - bBogusSu;

      const aCanon = /[るうくぐすつぬぶむい]$/.test(a.lemma) ? 1 : 0;
      const bCanon = /[るうくぐすつぬぶむい]$/.test(b.lemma) ? 1 : 0;
      if (aCanon !== bCanon) return bCanon - aCanon;
      if (a.reasons.length !== b.reasons.length) return b.reasons.length - a.reasons.length;
      return a.lemma.length - b.lemma.length;
    });
    return {
      lemma: inflected[0].lemma,
      reasons: inflected[0].reasons,
      grammarMeaning: inflected[0].grammarMeaning,
      steps: inflected[0].steps,
    };
  }

  return { lemma: surface, reasons: [], grammarMeaning: '', steps: [] };
}

/**
 * Fallback + deterministic morphological token merger for Japanese.
 * Ensures verbs/adjectives followed by auxiliary verbs (ます, た, ない, られる, させる, たい, ようだ, そうだ),
 * conjunctive particles (て, で, ながら, たり), and bound suffixes merge into ONE contiguous surface token.
 */
export function tokenizeWithIntlSegmenter(text: string): Token[] {
  if (!text) return [];

  const rawSegments: { segment: string; isWordLike: boolean; index: number }[] = [];
  if (typeof Intl !== 'undefined' && 'Segmenter' in (Intl as any)) {
    const segmenter = new (Intl as any).Segmenter('ja', { granularity: 'word' });
    for (const seg of segmenter.segment(text)) {
      rawSegments.push({
        segment: seg.segment,
        isWordLike: Boolean(seg.isWordLike),
        index: seg.index,
      });
    }
  } else {
    let c = 0;
    const parts = text.split(/([、。！？「」『』（）［］【】・…—\s\n\r\t.,!?"'()\[\]]+)/);
    for (const p of parts) {
      if (p) {
        rawSegments.push({
          segment: p,
          isWordLike: !JA_PUNCT_RE.test(p),
          index: c,
        });
        c += p.length;
      }
    }
  }

  const tokens: Token[] = [];
  let i = 0;

  while (i < rawSegments.length) {
    const seg = rawSegments[i];
    const raw = seg.segment;
    const isPunct = !seg.isWordLike || JA_PUNCT_RE.test(raw);

    if (isPunct) {
      tokens.push({
        id: `tok-${i}-${seg.index}`,
        surface: raw,
        baseForm: raw,
        isPunctuation: true,
        isWord: false,
        startIndex: seg.index,
        endIndex: seg.index + raw.length,
      });
      i++;
      continue;
    }

    // Standalone particle / copula (never swallow following tokens into a particle)
    const protectedInfo = PROTECTED_JA_GRAMMAR_TOKENS[raw];
    if (protectedInfo || JA_PARTICLES.has(raw)) {
      const entry = protectedInfo ? undefined : dictMap.get(raw);
      const reading = protectedInfo?.reading || entry?.readings[0];
      tokens.push({
        id: `tok-${i}-${seg.index}`,
        surface: raw,
        baseForm: raw,
        reading,
        furiganaSegments: [{ text: raw }],
        partOfSpeech: protectedInfo ? protectedInfo.badgeLabel : 'Grammar Particle',
        isPunctuation: false,
        isWord: true,
        level: protectedInfo?.level || entry?.level,
        frequencyRank: entry?.frequencyRank,
        morphTag: protectedInfo?.isCopula ? 'copula' : 'particle',
        startIndex: seg.index,
        endIndex: seg.index + raw.length,
      });
      i++;
      continue;
    }

    // Try merging contiguous predicate/auxiliary fragments starting at `i`
    let bestEndIdx = i;
    let bestCombined = raw;
    let bestDeinflection = chooseBestDeinflectionLemma(raw);

    const isKnownNonInflectingNoun = Boolean(
      isPureMultiKanji(raw) ||
        dictMap
          .get(raw)
          ?.partsOfSpeech.some((p) => /^(noun|na-adjective|adj-na)/i.test(p))
    );

    // Look ahead up to 10 contiguous non-punctuation, non-case-particle segments
    const MAX_LOOKAHEAD = Math.min(rawSegments.length - 1, i + 9);
    let candidateStr = raw;
    for (let j = i + 1; j <= MAX_LOOKAHEAD; j++) {
      const nxt = rawSegments[j];
      if (!nxt.isWordLike || JA_PUNCT_RE.test(nxt.segment)) break;

      // Never absorb copula tails (では, じゃ, だっ, だった, だろう, です, なら) into predicate
      if (JA_COPULA_START_RE.test(nxt.segment)) {
        break;
      }

      // Handle `だ` carefully: only absorb if `raw` is a genuine ん/い verb stem (読ん+だ, 泳い+だ), not a noun/na-adj
      if (nxt.segment === 'だ') {
        const canAcceptDa =
          !isKnownNonInflectingNoun &&
          candidateStr === raw &&
          /[んい]$/.test(raw) &&
          !isPureMultiKanji(raw.slice(0, -1));
        if (!canAcceptDa) break;
      } else if (JA_PARTICLES.has(nxt.segment) || PROTECTED_JA_GRAMMAR_TOKENS[nxt.segment]) {
        // Stop before standalone case/topic particles (な, に, は, が, etc.)
        break;
      }

      // Keep suru-noun / multi-kanji noun separate from する / し / できる so Rule C merges & decomposes them cleanly
      if (
        j === i + 1 &&
        isKnownNonInflectingNoun &&
        /^(し|する|でき|できる)$/.test(nxt.segment)
      ) {
        break;
      }

      // Only absorb next segment if:
      // 1) nxt is an inflection/okurigana/auxiliary fragment, OR
      // 2) merging it forms a valid deinflectable predicate
      const looksLikeAuxOrOkurigana =
        JA_INFLECTION_FRAG_RE.test(nxt.segment) ||
        (isKanjiPresent(raw) && raw.length <= 2 && /^[ぁ-ん]{1,3}$/.test(nxt.segment));

      if (!looksLikeAuxOrOkurigana) {
        break;
      }

      candidateStr += nxt.segment;
      const deinf = chooseBestDeinflectionLemma(candidateStr);

      // Accept merge if:
      // - It hits a standalone suru/dekiru chain, OR
      // - It hits a known dictionary entry, OR
      // - It deinflects with conjugation reasons, OR
      // - We are absorbing partial stem/okurigana toward a following auxiliary
      const partialBridge =
        j < MAX_LOOKAHEAD &&
        JA_INFLECTION_FRAG_RE.test(rawSegments[j + 1].segment) &&
        !JA_PARTICLES.has(rawSegments[j + 1].segment) &&
        !JA_COPULA_START_RE.test(rawSegments[j + 1].segment);

      if (STANDALONE_SURU_DEKIRU[candidateStr] || deinf.entry || deinf.reasons.length > 0 || partialBridge) {
        bestEndIdx = j;
        bestCombined = candidateStr;
        bestDeinflection = deinf;
      } else {
        break;
      }
    }

    if (bestEndIdx > i || bestDeinflection.reasons.length > 0) {
      const surface = bestCombined;
      const baseForm = bestDeinflection.lemma;
      const entry = bestDeinflection.entry || dictMap.get(baseForm) || dictMap.get(surface);
      const reading =
        entry?.readings[0] && surface === baseForm
          ? entry.readings[0]
          : entry?.readings[0] && isKanjiPresent(baseForm)
          ? surface.replace(baseForm.replace(/[ぁ-ん]+$/, ''), entry.readings[0].replace(/[ぁ-ん]+$/, ''))
          : undefined;
      const furiganaSegments = buildFurigana(surface, reading, baseForm);

      const explained =
        surface !== baseForm ? explainJapaneseInflection(surface, baseForm) : undefined;
      const grammarSuffix = explained?.grammarSuffix;
      const grammarMeaning =
        explained?.grammarMeaning || bestDeinflection.grammarMeaning || undefined;
      const grammarSteps =
        explained?.grammarSteps?.length
          ? explained.grammarSteps
          : bestDeinflection.steps.length > 0
          ? bestDeinflection.steps
          : undefined;

      const components = rawSegments.slice(i, bestEndIdx + 1).map((s, idx) => {
        const compBasic = idx === 0 ? baseForm : s.segment;
        const compPos = idx === 0 ? (entry?.partsOfSpeech[0] || 'Predicate') : 'Auxiliary / Suffix';
        const compMeaning =
          idx === 0
            ? entry?.meanings?.[0]
            : getJapaneseComponentMeaning(s.segment, compBasic, compPos);
        return {
          surface: s.segment,
          pos: compPos,
          basic: compBasic,
          meaning: compMeaning,
        };
      });

      const conjugatedForm =
        surface !== baseForm && grammarSuffix
          ? grammarMeaning
            ? `Conjugated (${grammarSuffix}) · ${grammarMeaning}`
            : `Conjugated (${grammarSuffix})`
          : bestDeinflection.grammarMeaning || undefined;

      tokens.push({
        id: `tok-${i}-${seg.index}`,
        surface,
        baseForm,
        reading: reading && reading !== surface ? reading : undefined,
        furiganaSegments,
        partOfSpeech: entry?.partsOfSpeech[0] || (baseForm.endsWith('い') ? 'I-adjective' : 'Verb'),
        isPunctuation: false,
        isWord: true,
        level: entry?.level,
        frequencyRank: entry?.frequencyRank,
        components,
        conjugatedForm,
        grammarSuffix,
        grammarMeaning,
        grammarSteps,
        startIndex: seg.index,
        endIndex: seg.index + surface.length,
      });

      i = bestEndIdx + 1;
      continue;
    }

    // Standalone word (Noun, Na-adjective stem, Derivational suffix, etc.)
    const entry = dictMap.get(raw);
    const reading = entry?.readings[0] || undefined;
    const furiganaSegments = reading ? buildFurigana(raw, reading, raw) : undefined;
    const rawPos = entry?.partsOfSpeech || [];
    const isNaAdj = rawPos.some((p) => /\b(adj-na|na-adjective)\b/i.test(p));
    const isVs = rawPos.some((p) => /\b(vs|vs-i|vs-s|suru)\b/i.test(p));

    tokens.push({
      id: `tok-${i}-${seg.index}`,
      surface: raw,
      baseForm: raw,
      reading,
      furiganaSegments,
      partOfSpeech: entry?.partsOfSpeech[0] || (JA_DERIVATIONAL_SUFFIXES.has(raw) ? 'Suffix' : 'Noun'),
      isPunctuation: false,
      isWord: true,
      level: entry?.level,
      frequencyRank: entry?.frequencyRank,
      morphTag: JA_DERIVATIONAL_SUFFIXES.has(raw)
        ? 'deriv-suffix'
        : isNaAdj
        ? 'na-adj-stem'
        : isVs
        ? 'vs-noun'
        : undefined,
      startIndex: seg.index,
      endIndex: seg.index + raw.length,
    });

    i++;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Post-Tokenization Morphological Merger (Phase 3D Rules A, B, C & Particles)
// ---------------------------------------------------------------------------

interface JaLexiconMeta {
  word: string;
  reading?: string;
  meanings: string[];
  partsOfSpeech: string[];
  level?: string;
  frequencyRank?: number;
  priorityScore?: number;
  isAdjNa: boolean;
  isVs: boolean;
}

function posArrayHasAdjNa(pos: string[]): boolean {
  return pos.some((p) => /\b(adj-na|na-adjective)\b|形容動詞/i.test(p));
}

function posArrayHasVs(pos: string[]): boolean {
  return pos.some((p) => /\b(vs|vs-i|vs-s)\b|suru\s*verb|サ変/i.test(p));
}

function toMetaFromSample(entry: typeof JAPANESE_DICTIONARY_SAMPLE[0]): JaLexiconMeta {
  const pos = entry.partsOfSpeech || [];
  return {
    word: entry.word,
    reading: entry.readings?.[0],
    meanings: entry.meanings || [],
    partsOfSpeech: pos,
    level: entry.level,
    frequencyRank: entry.frequencyRank,
    isAdjNa: posArrayHasAdjNa(pos),
    isVs: posArrayHasVs(pos),
  };
}

function toMetaFromDb(item: JmdictEntryItem): JaLexiconMeta {
  const pos = Array.from(new Set(item.senses.flatMap((s) => s.partsOfSpeech || [])));
  const meanings = item.senses.flatMap((s) => s.glosses || []);
  return {
    word: item.primaryWord,
    reading: item.primaryReading || item.kana?.[0]?.text,
    meanings,
    partsOfSpeech: pos,
    level: item.jlptLevel,
    frequencyRank: item.frequencyRank,
    priorityScore: item.priorityScore,
    isAdjNa: posArrayHasAdjNa(pos),
    isVs: posArrayHasVs(pos),
  };
}

function matchNaAdjTail(
  arr: Token[],
  startIdx: number
): { tailSurface: string; count: number; lastToken: Token } | null {
  const t1 = arr[startIdx];
  if (!t1 || !t1.isWord) return null;

  const t2 = arr[startIdx + 1];
  const t3 = arr[startIdx + 2];
  const contiguous2 = Boolean(t2 && t2.isWord && t1.endIndex === t2.startIndex);
  const contiguous3 = Boolean(contiguous2 && t3 && t3.isWord && t2.endIndex === t3.startIndex);

  if (contiguous3) {
    const s3 = `${t1.surface}${t2.surface}${t3.surface}`;
    if (s3 === 'だった' || s3 === 'ではない' || s3 === 'ではなかった') {
      return { tailSurface: s3, count: 3, lastToken: t3 };
    }
  }

  if (contiguous2) {
    const s2 = `${t1.surface}${t2.surface}`;
    if (
      s2 === 'だった' ||
      s2 === 'ではない' ||
      s2 === 'じゃない' ||
      s2 === 'ではなかった' ||
      s2 === 'じゃなかった' ||
      s2 === 'ではありません' ||
      s2 === 'じゃありません' ||
      s2 === 'でした' ||
      s2 === 'だろう'
    ) {
      return { tailSurface: s2, count: 2, lastToken: t2 };
    }
  }

  const s1 = t1.surface;
  if (
    s1 === 'な' ||
    s1 === 'に' ||
    s1 === 'だ' ||
    s1 === 'だった' ||
    s1 === 'だろう' ||
    s1 === 'ではない' ||
    s1 === 'じゃない' ||
    s1 === 'ではなかった' ||
    s1 === 'じゃなかった' ||
    s1 === 'なら' ||
    s1 === 'です' ||
    s1 === 'でした'
  ) {
    return { tailSurface: s1, count: 1, lastToken: t1 };
  }

  return null;
}

/**
 * Post-tokenization morphological merger applying Phase 3D Rules A, B, and C, plus standalone
 * particle protection across both Kuromoji and Intl.Segmenter token streams.
 */
export async function postMergeJapaneseTokens(tokens: Token[]): Promise<Token[]> {
  if (!tokens || tokens.length === 0) return tokens;

  // Collect all candidate dictionary terms we need for Rules A, B, C in a single batch query
  const lookupKeys = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i];
    if (!cur.isWord) continue;
    const base = cur.baseForm || cur.surface;
    lookupKeys.add(cur.surface);
    lookupKeys.add(base);
    lookupKeys.add(`${base}する`);
    if (i + 1 < tokens.length && tokens[i + 1].isWord && cur.endIndex === tokens[i + 1].startIndex) {
      const suf = tokens[i + 1].surface;
      if (tokens[i + 1].morphTag === 'deriv-suffix' || JA_DERIVATIONAL_SUFFIXES.has(suf)) {
        const comb = `${cur.surface}${suf}`;
        lookupKeys.add(comb);
        lookupKeys.add(`${comb}する`);
      }
    }
  }

  const metaMap = new Map<string, JaLexiconMeta>();
  // Pre-seed from sample dictionary
  for (const key of lookupKeys) {
    const sample = dictMap.get(key);
    if (sample) {
      metaMap.set(key, toMetaFromSample(sample));
    }
  }

  // Batch-query IndexedDB JMdict entries (preferring higher priorityScore & actual word entries over kanji-only entries)
  if (lookupKeys.size > 0) {
    try {
      const dbRows = await db.jmdictEntries
        .where('forms')
        .anyOf(Array.from(lookupKeys))
        .toArray();
      const sortedRows = dbRows
        .filter((r) => !r.languageCode || r.languageCode === 'ja')
        .sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));

      for (const row of sortedRows) {
        const meta = toMetaFromDb(row);
        const candidates = [row.primaryWord, ...(row.kanji || []).map((k) => k.text)];
        for (const c of candidates) {
          if (!lookupKeys.has(c)) continue;
          const existing = metaMap.get(c);
          if (!existing) {
            metaMap.set(c, meta);
          } else {
            // Merge adj-na / vs flags across homograph/sense entries so pos detection never misses
            metaMap.set(c, {
              ...existing,
              reading: existing.reading || meta.reading,
              meanings: existing.meanings.length > 0 ? existing.meanings : meta.meanings,
              level: existing.level || meta.level,
              frequencyRank: existing.frequencyRank || meta.frequencyRank,
              isAdjNa: existing.isAdjNa || meta.isAdjNa,
              isVs: existing.isVs || meta.isVs,
            });
          }
        }
      }
    } catch {
      // IndexedDB unavailable in some environments; sample map still applies
    }
  }

  // -------------------------------------------------------------------------
  // Rule A — Derivational Suffix Compounds (伝統 + 的 -> 伝統的)
  // Merge noun/stem + derivational suffix (的, 性, 化, 風, 感, 者, 員, 力, 中, 上, 下, 内, 外)
  // when the combined string exists as an entry in JMdict / sample dictionary.
  // -------------------------------------------------------------------------
  const afterRuleA: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i];
    const nxt = tokens[i + 1];
    if (
      cur.isWord &&
      nxt &&
      nxt.isWord &&
      cur.endIndex === nxt.startIndex &&
      (nxt.morphTag === 'deriv-suffix' || JA_DERIVATIONAL_SUFFIXES.has(nxt.surface))
    ) {
      const combined = `${cur.surface}${nxt.surface}`;
      const combMeta = metaMap.get(combined);
      if (combMeta) {
        const stemMeta = metaMap.get(cur.baseForm || cur.surface);
        const combinedReading =
          combMeta.reading ||
          (cur.reading && nxt.reading ? `${cur.reading}${nxt.reading}` : undefined);
        const furiganaSegments = combinedReading
          ? buildFurigana(combined, combinedReading, combined)
          : cur.furiganaSegments && nxt.furiganaSegments
          ? [...cur.furiganaSegments, ...nxt.furiganaSegments]
          : undefined;

        const components: GrammarComponent[] = [
          ...(cur.components && cur.components.length > 0
            ? cur.components
            : [
                {
                  surface: cur.surface,
                  pos: cur.partOfSpeech || 'Noun',
                  basic: cur.baseForm || cur.surface,
                  reading: cur.reading,
                  meaning: stemMeta?.meanings[0],
                },
              ]),
          {
            surface: nxt.surface,
            pos: 'Suffix',
            basic: nxt.baseForm || nxt.surface,
            reading: nxt.reading,
            meaning: JA_DERIVATIONAL_SUFFIX_GLOSSES[nxt.surface] || 'derivational suffix',
          },
        ];

        afterRuleA.push({
          id: cur.id,
          surface: combined,
          baseForm: combined,
          reading: combinedReading,
          furiganaSegments,
          partOfSpeech: combMeta.partsOfSpeech[0] || (combMeta.isAdjNa ? 'Na-adjective' : 'Noun'),
          isPunctuation: false,
          isWord: true,
          level: combMeta.level || cur.level,
          frequencyRank: combMeta.frequencyRank || cur.frequencyRank,
          morphTag: combMeta.isAdjNa ? 'na-adj-stem' : combMeta.isVs ? 'vs-noun' : undefined,
          components,
          startIndex: cur.startIndex,
          endIndex: nxt.endIndex,
        });
        i++;
        continue;
      }
    }
    afterRuleA.push(cur);
  }

  // -------------------------------------------------------------------------
  // Rule B — Na-Adjectives + Attributive/Copula Chains (大切 + な, 伝統的 + な, 静か + だった/ではない/じゃない/に...)
  // -------------------------------------------------------------------------
  const afterRuleB: Token[] = [];
  for (let i = 0; i < afterRuleA.length; i++) {
    const cur = afterRuleA[i];
    if (cur.isWord) {
      const stemKey = cur.baseForm || cur.surface;
      const stemMeta = metaMap.get(stemKey) || metaMap.get(cur.surface);
      const isNaAdjStem =
        cur.morphTag === 'na-adj-stem' ||
        Boolean(stemMeta?.isAdjNa) ||
        (cur.surface.endsWith('的') && Boolean(cur.components?.some((c) => c.surface === '的')));

      if (isNaAdjStem && i + 1 < afterRuleA.length && cur.endIndex === afterRuleA[i + 1].startIndex) {
        const tailMatch = matchNaAdjTail(afterRuleA, i + 1);
        if (tailMatch) {
          const naExp = explainNaAdjectiveSuffix(tailMatch.tailSurface);
          if (naExp) {
            const mergedSurface = `${cur.surface}${tailMatch.tailSurface}`;
            const baseForm = cur.baseForm || cur.surface;
            const stemReading = cur.reading || stemMeta?.reading;
            const mergedReading = stemReading ? `${stemReading}${tailMatch.tailSurface}` : undefined;
            const furiganaSegments = cur.furiganaSegments
              ? [...cur.furiganaSegments, { text: tailMatch.tailSurface }]
              : stemReading
              ? [...(buildFurigana(cur.surface, stemReading, baseForm) || [{ text: cur.surface }]), { text: tailMatch.tailSurface }]
              : undefined;

            const tailPosLabel =
              tailMatch.tailSurface === 'な'
                ? 'Na-adjective Modifier'
                : tailMatch.tailSurface === 'に'
                ? 'Adverbial Marker'
                : 'Copula';

            const components: GrammarComponent[] = [
              ...(cur.components && cur.components.length > 0
                ? cur.components
                : [
                    {
                      surface: cur.surface,
                      pos: 'Na-adjective',
                      basic: baseForm,
                      reading: stemReading,
                      meaning: stemMeta?.meanings[0],
                    },
                  ]),
              {
                surface: tailMatch.tailSurface,
                pos: tailPosLabel,
                basic: tailMatch.tailSurface,
                meaning: naExp.stepMeaning,
              },
            ];

            afterRuleB.push({
              id: cur.id,
              surface: mergedSurface,
              baseForm,
              reading: mergedReading,
              furiganaSegments,
              partOfSpeech: 'Na-adjective',
              isPunctuation: false,
              isWord: true,
              level: cur.level || stemMeta?.level,
              frequencyRank: cur.frequencyRank || stemMeta?.frequencyRank,
              components,
              conjugatedForm: `Conjugated (${naExp.grammarSuffix}) · ${naExp.grammarMeaning}`,
              grammarSuffix: naExp.grammarSuffix,
              grammarMeaning: naExp.grammarMeaning,
              grammarSteps: [{ suffix: tailMatch.tailSurface, meaning: naExp.stepMeaning, kind: 'na-adj' }],
              startIndex: cur.startIndex,
              endIndex: tailMatch.lastToken.endIndex,
            });
            i += tailMatch.count;
            continue;
          }
        }
      }
    }
    afterRuleB.push(cur);
  }

  // -------------------------------------------------------------------------
  // Rule C — Suru-Verbs (生活 + する, 勉強 + しています, 運動 + できる)
  // -------------------------------------------------------------------------
  const afterRuleC: Token[] = [];
  for (let i = 0; i < afterRuleB.length; i++) {
    const cur = afterRuleB[i];
    const nxt = afterRuleB[i + 1];
    if (cur.isWord && nxt && nxt.isWord && cur.endIndex === nxt.startIndex) {
      const nxtBase = nxt.baseForm || nxt.surface;
      const isSuruOrDekiruVerb =
        nxt.surface === 'する' ||
        nxt.surface === 'できる' ||
        nxtBase === 'する' ||
        nxtBase === 'できる' ||
        Boolean(STANDALONE_SURU_DEKIRU[nxt.surface]);

      if (isSuruOrDekiruVerb) {
        const nounKey = cur.baseForm || cur.surface;
        const nounMeta = metaMap.get(nounKey) || metaMap.get(cur.surface);
        const compoundLemma = `${nounKey}する`;
        const compoundMeta = metaMap.get(compoundLemma);
        const isVsNoun =
          cur.morphTag === 'vs-noun' ||
          Boolean(nounMeta?.isVs) ||
          Boolean(compoundMeta);

        if (isVsNoun) {
          const baseVerb: 'する' | 'できる' =
            nxtBase === 'できる' || nxt.surface.startsWith('でき') ? 'できる' : 'する';
          const suruExp = explainSuruVerbSuffix(nxt.surface, baseVerb);
          const resolvedBaseForm = compoundMeta ? compoundLemma : nounKey;
          const mergedSurface = `${cur.surface}${nxt.surface}`;
          const stemReading = cur.reading || nounMeta?.reading;
          const mergedReading = stemReading ? `${stemReading}${nxt.surface}` : undefined;
          const furiganaSegments = cur.furiganaSegments
            ? [...cur.furiganaSegments, { text: nxt.surface }]
            : stemReading
            ? [...(buildFurigana(cur.surface, stemReading, nounKey) || [{ text: cur.surface }]), { text: nxt.surface }]
            : undefined;

          const components: GrammarComponent[] = [
            {
              surface: cur.surface,
              pos: 'Noun',
              basic: nounKey,
              reading: stemReading,
              meaning: nounMeta?.meanings[0] || compoundMeta?.meanings[0],
            },
            {
              surface: nxt.surface,
              pos: baseVerb === 'できる' ? 'Potential Verb (する)' : 'Suru Verb',
              basic: baseVerb,
              meaning: suruExp.verbComponentMeaning,
            },
          ];

          afterRuleC.push({
            id: cur.id,
            surface: mergedSurface,
            baseForm: resolvedBaseForm,
            reading: mergedReading,
            furiganaSegments,
            partOfSpeech: 'Suru verb',
            isPunctuation: false,
            isWord: true,
            level: compoundMeta?.level || cur.level || nounMeta?.level,
            frequencyRank: compoundMeta?.frequencyRank || cur.frequencyRank || nounMeta?.frequencyRank,
            components,
            conjugatedForm: `Conjugated (${suruExp.grammarSuffix}) · ${suruExp.grammarMeaning}`,
            grammarSuffix: suruExp.grammarSuffix,
            grammarMeaning: suruExp.grammarMeaning,
            grammarSteps: suruExp.steps,
            startIndex: cur.startIndex,
            endIndex: nxt.endIndex,
          });
          i++;
          continue;
        }
      }
    }
    afterRuleC.push(cur);
  }

  // Final pass: protect any remaining standalone particles/copulas from kanji homonym metadata
  for (const tok of afterRuleC) {
    if (!tok.isWord) continue;
    const pInfo = PROTECTED_JA_GRAMMAR_TOKENS[tok.surface];
    if (pInfo && (!tok.baseForm || tok.baseForm === tok.surface)) {
      tok.partOfSpeech = pInfo.badgeLabel;
      tok.reading = pInfo.reading;
      tok.level = pInfo.level;
      tok.morphTag = pInfo.isCopula ? 'copula' : 'particle';
      tok.furiganaSegments = [{ text: tok.surface }];
    }
  }

  return afterRuleC;
}

export async function tokenizeJapanese(text: string, cacheKey?: string): Promise<Token[]> {
  if (!text) return [];

  // Check in-memory document token cache
  const key = cacheKey || `hash:${text.length}:${text.slice(0, 40)}:${text.slice(-40)}`;
  if (documentTokenCache.has(key)) {
    return documentTokenCache.get(key)!;
  }

  let tokens: Token[] = [];

  try {
    // Attempt worker initialization with local /dict/ path
    await initWorker(DEFAULT_DIC_PATH);

    if (!workerInstance) {
      throw new Error('Worker instance unavailable');
    }

    const msgId = `tok-${++messageSeq}`;
    tokens = await new Promise<Token[]>((resolve, reject) => {
      let timer: any = null;

      const cleanupTimer = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      // 10s timeout per tokenization request
      timer = setTimeout(() => {
        cleanupTimer();
        pendingCallbacks.delete(msgId);
        reject(new Error('Tokenize request timed out after 10s'));
      }, 10000);

      pendingCallbacks.set(msgId, {
        resolve: (res) => {
          cleanupTimer();
          resolve(res);
        },
        reject: (err) => {
          cleanupTimer();
          reject(err);
        },
      });

      workerInstance!.postMessage({
        type: 'tokenize',
        id: msgId,
        text,
        dicPath: DEFAULT_DIC_PATH,
      });
    });

    tokenizerWarning = null;
  } catch (err: any) {
    console.warn('Tokenizer worker fell back to native segmenter:', err);
    tokens = tokenizeWithIntlSegmenter(text);
  }

  // Apply Phase 3D Rule A/B/C morphological merging and particle protection
  tokens = await postMergeJapaneseTokens(tokens);

  // Enrich with dictionary metadata if available (skipping protected particles/copulas)
  for (const token of tokens) {
    if (!token.isWord) continue;
    if (PROTECTED_JA_GRAMMAR_TOKENS[token.surface] && (!token.baseForm || token.baseForm === token.surface)) {
      continue;
    }
    const lookupKey = token.baseForm || token.surface;
    const entry = dictMap.get(lookupKey) || dictMap.get(token.surface);
    if (entry) {
      if (!token.level && entry.level) token.level = entry.level;
      if (!token.frequencyRank && entry.frequencyRank) token.frequencyRank = entry.frequencyRank;
    }
  }

  // Cache tokenized result
  documentTokenCache.set(key, tokens);
  return tokens;
}

/**
 * Checks whether Kuromoji dictionary files are physically cached in Cache Storage.
 */
export async function getKuromojiCacheStatus(): Promise<{
  isInstalled: boolean;
  fileCount: number;
  sizeBytes: number;
}> {
  if (typeof caches === 'undefined') {
    return { isInstalled: false, fileCount: 0, sizeBytes: 0 };
  }
  try {
    const hasCache = await caches.has('kuromoji-dict-v1');
    if (!hasCache) {
      return { isInstalled: false, fileCount: 0, sizeBytes: 0 };
    }
    const cache = await caches.open('kuromoji-dict-v1');
    const keys = await cache.keys();
    if (keys.length === 0) {
      return { isInstalled: false, fileCount: 0, sizeBytes: 0 };
    }
    let totalSize = 0;
    for (const req of keys) {
      const resp = await cache.match(req);
      if (resp) {
        const cl = resp.headers.get('content-length');
        if (cl) {
          totalSize += parseInt(cl, 10);
        } else {
          try {
            const blob = await resp.clone().blob();
            totalSize += blob.size;
          } catch {
            totalSize += 1500000;
          }
        }
      }
    }
    return {
      isInstalled: keys.length >= 8,
      fileCount: keys.length,
      sizeBytes: totalSize || 18874368,
    };
  } catch (err) {
    return { isInstalled: false, fileCount: 0, sizeBytes: 0 };
  }
}

/**
 * Downloads and caches all 12 Kuromoji dictionary files into Cache Storage for offline use.
 */
export async function installKuromojiOffline(
  onProgress?: (percent: number, currentFile: string) => void
): Promise<number> {
  if (typeof caches === 'undefined') {
    throw new Error('CacheStorage API is not supported in this browser.');
  }

  const cache = await caches.open('kuromoji-dict-v1');
  const files = [
    'base.dat.gz',
    'check.dat.gz',
    'tid.dat.gz',
    'tid_map.dat.gz',
    'tid_pos.dat.gz',
    'unk.dat.gz',
    'unk_char.dat.gz',
    'unk_compat.dat.gz',
    'unk_invoke.dat.gz',
    'unk_map.dat.gz',
    'unk_pos.dat.gz',
    'cc.dat.gz',
  ];

  let totalBytes = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(Math.round((i / files.length) * 100), file);

    const url = `/dict/${file}`;
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) {
      throw new Error(`Failed to download dictionary file ${file}: HTTP ${resp.status}`);
    }

    const clone = resp.clone();
    await cache.put(url, resp);
    const blob = await clone.blob();
    totalBytes += blob.size;
  }

  onProgress?.(100, 'Complete');
  return totalBytes;
}

/**
 * Removes cached Kuromoji dictionary files from Cache Storage.
 */
export async function deleteKuromojiOfflineCache(): Promise<void> {
  if (typeof caches !== 'undefined') {
    await caches.delete('kuromoji-dict-v1');
  }
}
