// Shims for UMD compatibility in worker before any imports
if (typeof self !== 'undefined') {
  (self as any).global = self;
  (self as any).window = self;
  if (!(self as any).Zlib) {
    (self as any).Zlib = {};
  }
}

import { katakanaToHiragana, buildFurigana } from './kanaUtils';
import {
  explainJapaneseInflection,
  explainNaAdjectiveSuffix,
  explainSuruVerbSuffix,
  getJapaneseComponentMeaning,
  JA_DERIVATIONAL_SUFFIXES,
} from './deinflector';

let tokenizerPromise: Promise<any> | null = null;
let tokenizerInstance: any = null;

// Local bundled dictionary path with trailing slash
const DEFAULT_DIC_PATH = '/dict/';

async function initTokenizer(dicPath = DEFAULT_DIC_PATH): Promise<any> {
  if (tokenizerInstance) return tokenizerInstance;
  if (tokenizerPromise) return tokenizerPromise;

  // Ensure trailing slash
  const cleanDicPath = dicPath.endsWith('/') ? dicPath : `${dicPath}/`;

  tokenizerPromise = new Promise(async (resolve, reject) => {
    try {
      // Dynamic import ensures (self as any).global = self is strictly evaluated first
      const kuromojiModule = await import('kuromoji');
      const kuromoji = (kuromojiModule.default || kuromojiModule) as any;

      kuromoji.builder({ dicPath: cleanDicPath }).build((err: any, tokenizer: any) => {
        if (err) {
          tokenizerPromise = null;
          reject(err);
        } else {
          tokenizerInstance = tokenizer;
          resolve(tokenizer);
        }
      });
    } catch (e) {
      tokenizerPromise = null;
      reject(e);
    }
  });

  return tokenizerPromise;
}

export interface RawKuromojiToken {
  surface_form: string;
  pos: string;
  pos_detail_1: string;
  pos_detail_2: string;
  pos_detail_3: string;
  conjugated_type: string;
  conjugated_form: string;
  basic_form: string;
  reading?: string;
  pronunciation?: string;
}

function collectVerbGroup(rawTokens: RawKuromojiToken[], startIdx: number): {
  group: RawKuromojiToken[];
  nextIdx: number;
} {
  const cur = rawTokens[startIdx];
  const group: RawKuromojiToken[] = [cur];
  let j = startIdx + 1;

  while (j < rawTokens.length) {
    const next = rawTokens[j];

    // 1. Chained auxiliary verbs (助動詞: ます, た, だ, ない, ぬ, せる, れる, られる, させる, たい, ようだ, そうだ, etc.)
    if (next.pos === '助動詞') {
      group.push(next);
      j++;
      continue;
    }

    // 2. Chained bound suffixes (動詞/形容詞/名詞 接尾 or 接尾辞: られ, させ, すぎる, そう, さ, etc.)
    if (next.pos === '接尾辞' || next.pos_detail_1 === '接尾') {
      group.push(next);
      j++;
      continue;
    }

    // 3. Chained non-independent subsidiary verbs/adjectives (e.g. て + い + ます, なく + ない)
    if ((next.pos === '動詞' || next.pos === '形容詞') && next.pos_detail_1 === '非自立') {
      group.push(next);
      j++;
      continue;
    }

    // 4. Chained conjunctive particles (接続助詞: て, で, ながら, たり, だり)
    if (
      next.pos === '助詞' &&
      (next.pos_detail_1 === '接続助詞' ||
        next.surface_form === 'て' ||
        next.surface_form === 'で' ||
        next.surface_form === 'ながら' ||
        next.surface_form === 'たり' ||
        next.surface_form === 'だり')
    ) {
      if (next.surface_form === 'て' || next.surface_form === 'で') {
        group.push(next);
        j++;
        if (
          j < rawTokens.length &&
          (rawTokens[j].pos === '動詞' || rawTokens[j].pos === '助動詞') &&
          (rawTokens[j].pos === '助動詞' ||
            rawTokens[j].pos_detail_1 === '非自立' ||
            ['い', 'いる', 'ある', 'おく', 'しまう', 'みる', 'くる', 'いく', 'おり', 'おる'].includes(
              rawTokens[j].surface_form
            ))
        ) {
          group.push(rawTokens[j]);
          j++;
        }
        continue;
      }

      if (next.surface_form === 'ながら' || next.surface_form === 'たり' || next.surface_form === 'だり') {
        group.push(next);
        j++;
        continue;
      }
    }

    break;
  }

  return { group, nextIdx: j };
}

function collectNaAdjCopulaTail(
  rawTokens: RawKuromojiToken[],
  startIdx: number
): { tail: RawKuromojiToken[]; nextIdx: number } | null {
  const n1 = rawTokens[startIdx];
  if (!n1) return null;

  // Single-token simple tails: な, に, だ, です, なら
  if (
    (n1.surface_form === 'な' && (n1.pos === '助動詞' || n1.pos === '助詞')) ||
    (n1.surface_form === 'に' && (n1.pos === '助詞' || n1.pos === '助動詞')) ||
    n1.surface_form === 'なら' ||
    n1.surface_form === 'です'
  ) {
    return { tail: [n1], nextIdx: startIdx + 1 };
  }

  // Multi-token copula chains: だった (だっ+た), だろう (だろ+う), だ, でした (でし+た)
  if (n1.surface_form === 'だ' || n1.surface_form === 'だっ' || n1.surface_form === 'だろ' || n1.surface_form === 'でし') {
    const tail: RawKuromojiToken[] = [n1];
    let j = startIdx + 1;
    while (j < rawTokens.length && rawTokens[j].pos === '助動詞') {
      tail.push(rawTokens[j]);
      j++;
    }
    const joined = tail.map((t) => t.surface_form).join('');
    if (['だ', 'だった', 'だろう', 'でした'].includes(joined)) {
      return { tail, nextIdx: j };
    }
  }

  // Negative copula chains: ではない / ではなかった / ではありません / じゃない / じゃなかった / じゃありません
  const n2 = rawTokens[startIdx + 1];
  const n3 = rawTokens[startIdx + 2];
  if (n1.surface_form === 'で' && n2?.surface_form === 'は' && n3 && ['ない', 'なかっ', 'あり'].includes(n3.surface_form)) {
    const tail: RawKuromojiToken[] = [n1, n2, n3];
    let j = startIdx + 3;
    while (j < rawTokens.length && (rawTokens[j].pos === '助動詞' || rawTokens[j].surface_form === 'た' || rawTokens[j].surface_form === 'ません')) {
      tail.push(rawTokens[j]);
      j++;
    }
    return { tail, nextIdx: j };
  }
  if ((n1.surface_form === 'では' || n1.surface_form === 'じゃ') && n2 && ['ない', 'なかっ', 'あり'].includes(n2.surface_form)) {
    const tail: RawKuromojiToken[] = [n1, n2];
    let j = startIdx + 2;
    while (j < rawTokens.length && (rawTokens[j].pos === '助動詞' || rawTokens[j].surface_form === 'た' || rawTokens[j].surface_form === 'ません')) {
      tail.push(rawTokens[j]);
      j++;
    }
    return { tail, nextIdx: j };
  }

  return null;
}

export function mergeRawTokens(rawTokens: RawKuromojiToken[], text: string) {
  const merged: any[] = [];
  let cursor = 0;
  let i = 0;

  while (i < rawTokens.length) {
    const cur = rawTokens[i];
    const curSurface = cur.surface_form;
    const startIndex = text.indexOf(curSurface, cursor);
    const safeStart = startIndex >= 0 ? startIndex : cursor;

    // Check if punctuation/whitespace/symbols
    const isPunct =
      cur.pos === '記号' ||
      /^[、。！？「」『』（）［］【】・…—\s\n\r\t.,!?"'()\[\]]+$/.test(curSurface);

    if (isPunct) {
      merged.push({
        id: `tok-${i}-${safeStart}`,
        surface: curSurface,
        baseForm: curSurface,
        reading: undefined,
        furiganaSegments: undefined,
        partOfSpeech: 'Punctuation',
        isPunctuation: true,
        isWord: false,
        startIndex: safeStart,
        endIndex: safeStart + curSurface.length,
      });
      cursor = safeStart + curSurface.length;
      i++;
      continue;
    }

    // Rule B (Kuromoji POS): Na-adjective stem (名詞, 形容動詞語幹, excluding 接尾 which Rule A handles first)
    if (cur.pos === '名詞' && cur.pos_detail_1 === '形容動詞語幹') {
      const copulaMatch = collectNaAdjCopulaTail(rawTokens, i + 1);
      if (copulaMatch) {
        const tailStr = copulaMatch.tail.map((t) => t.surface_form).join('');
        const naExp = explainNaAdjectiveSuffix(tailStr);
        if (naExp) {
          const group = [cur, ...copulaMatch.tail];
          const surface = group.map((t) => t.surface_form).join('');
          const baseForm = cur.basic_form && cur.basic_form !== '*' ? cur.basic_form : cur.surface_form;
          const reading = katakanaToHiragana(group.map((t) => t.reading || '').join(''));
          const stemReading = cur.reading ? katakanaToHiragana(cur.reading) : undefined;
          const furiganaSegments = [
            ...(buildFurigana(cur.surface_form, stemReading, baseForm) || [{ text: cur.surface_form }]),
            { text: tailStr },
          ];
          const components = [
            {
              surface: cur.surface_form,
              basic: baseForm,
              pos: 'Na-adjective',
              reading: stemReading,
            },
            {
              surface: tailStr,
              basic: tailStr,
              pos: tailStr === 'な' ? 'Attributive' : tailStr === 'に' ? 'Adverbial' : 'Copula',
              reading: katakanaToHiragana(copulaMatch.tail.map((t) => t.reading || '').join('')) || tailStr,
              meaning: naExp.grammarMeaning,
            },
          ];

          merged.push({
            id: `tok-${i}-${safeStart}`,
            surface,
            baseForm,
            reading: reading || undefined,
            furiganaSegments,
            partOfSpeech: 'Na-adjective',
            isPunctuation: false,
            isWord: true,
            morphTag: 'na-adj-stem',
            conjugatedForm: `Conjugated (${naExp.grammarSuffix}) · ${naExp.grammarMeaning}`,
            grammarSuffix: naExp.grammarSuffix,
            grammarMeaning: naExp.grammarMeaning,
            grammarSteps: [{ suffix: tailStr, meaning: naExp.grammarMeaning, kind: 'na-adj' }],
            components,
            startIndex: safeStart,
            endIndex: safeStart + surface.length,
          });

          cursor = safeStart + surface.length;
          i = copulaMatch.nextIdx;
          continue;
        }
      }
    }

    // Rule C (Kuromoji POS): Suru-noun (名詞, サ変接続) + する / できる (and its conjugated chain)
    const nextTok = rawTokens[i + 1];
    if (
      cur.pos === '名詞' &&
      cur.pos_detail_1 === 'サ変接続' &&
      nextTok &&
      nextTok.pos === '動詞' &&
      (nextTok.basic_form === 'する' || nextTok.basic_form === 'できる')
    ) {
      const { group: verbGroup, nextIdx } = collectVerbGroup(rawTokens, i + 1);
      const verbSurface = verbGroup.map((t) => t.surface_form).join('');
      const baseVerb = nextTok.basic_form === 'できる' ? 'できる' : 'する';
      const suruExp = explainSuruVerbSuffix(verbSurface, baseVerb);
      const surface = `${cur.surface_form}${verbSurface}`;
      const baseForm = cur.basic_form && cur.basic_form !== '*' ? cur.basic_form : cur.surface_form;
      const stemReading = cur.reading ? katakanaToHiragana(cur.reading) : undefined;
      const verbReading = katakanaToHiragana(verbGroup.map((t) => t.reading || '').join(''));
      const fullReading = `${stemReading || ''}${verbReading || ''}`;
      const furiganaSegments = [
        ...(buildFurigana(cur.surface_form, stemReading, baseForm) || [{ text: cur.surface_form }]),
        { text: verbSurface },
      ];
      const components = [
        {
          surface: cur.surface_form,
          basic: baseForm,
          pos: 'Noun (Suru verb)',
          reading: stemReading,
        },
        {
          surface: verbSurface,
          basic: baseVerb,
          pos: 'Verb',
          reading: verbReading || verbSurface,
          meaning: suruExp.verbComponentMeaning,
        },
      ];

      merged.push({
        id: `tok-${i}-${safeStart}`,
        surface,
        baseForm,
        reading: fullReading || undefined,
        furiganaSegments,
        partOfSpeech: 'Verb (Suru)',
        isPunctuation: false,
        isWord: true,
        morphTag: 'vs-noun',
        conjugatedForm: `Conjugated (${suruExp.grammarSuffix}) · ${suruExp.grammarMeaning}`,
        grammarSuffix: suruExp.grammarSuffix,
        grammarMeaning: suruExp.grammarMeaning,
        grammarSteps: suruExp.steps,
        components,
        startIndex: safeStart,
        endIndex: safeStart + surface.length,
      });

      cursor = safeStart + surface.length;
      i = nextIdx;
      continue;
    }

    // Check if Head is a Verb (動詞) or Adjective (形容詞)
    if (cur.pos === '動詞' || cur.pos === '形容詞') {
      const { group, nextIdx: j } = collectVerbGroup(rawTokens, i);

      const surface = group.map((t) => t.surface_form).join('');
      const baseForm =
        cur.basic_form && cur.basic_form !== '*' ? cur.basic_form : cur.surface_form;

      const rawReadingKana = group.map((t) => t.reading || '').join('');
      const reading = katakanaToHiragana(rawReadingKana);

      // Compute human-readable grammar explanation + suffix for conjugated forms
      const auxParts = group.slice(1).map((t) => t.surface_form).join('');
      const explained =
        surface !== baseForm ? explainJapaneseInflection(surface, baseForm) : undefined;

      const grammarSuffix =
        explained?.grammarSuffix || (auxParts ? `-${auxParts}` : surface !== baseForm ? `-${surface}` : undefined);

      const components = group.map((t, idx) => {
        const compBasic = t.basic_form && t.basic_form !== '*' ? t.basic_form : t.surface_form;
        const compPos = `${t.pos}${t.pos_detail_1 ? ` (${t.pos_detail_1})` : ''}`;
        const compReading = t.reading ? katakanaToHiragana(t.reading) : undefined;
        const compMeaning =
          idx > 0 ? getJapaneseComponentMeaning(t.surface_form, compBasic, compPos) : undefined;
        return {
          surface: t.surface_form,
          basic: compBasic,
          pos: compPos,
          reading: compReading,
          meaning: compMeaning,
        };
      });

      const fallbackChainMeaning = components
        .slice(1)
        .map((c) => c.meaning)
        .filter((m): m is string => Boolean(m))
        .join(' + ');

      const grammarMeaning = explained?.grammarMeaning || fallbackChainMeaning || undefined;
      const grammarSteps = explained?.grammarSteps?.length ? explained.grammarSteps : undefined;
      const conjugatedForm = grammarSuffix
        ? grammarMeaning
          ? `Conjugated (${grammarSuffix}) · ${grammarMeaning}`
          : `Conjugated (${grammarSuffix})`
        : undefined;

      // Generate furigana segments based on token's surface and reading
      const furiganaSegments = buildFurigana(surface, reading, baseForm);

      merged.push({
        id: `tok-${i}-${safeStart}`,
        surface,
        baseForm,
        reading: reading || undefined,
        furiganaSegments,
        partOfSpeech: cur.pos === '動詞' ? 'Verb' : 'I-adjective',
        isPunctuation: false,
        isWord: true,
        conjugatedForm,
        grammarSuffix,
        grammarMeaning,
        grammarSteps,
        components,
        startIndex: safeStart,
        endIndex: safeStart + surface.length,
      });

      cursor = safeStart + surface.length;
      i = j;
      continue;
    }

    // Standalone Particle, Copula, Derivational Suffix, Noun, Adverb, Conjunction, etc.
    const isParticle = cur.pos === '助詞';
    const isCopula = cur.pos === '助動詞' && (cur.basic_form === 'だ' || cur.basic_form === 'です' || curSurface === 'だ' || curSurface === 'です');
    const isDerivSuffix =
      cur.pos === '接尾辞' ||
      cur.pos_detail_1 === '接尾' ||
      JA_DERIVATIONAL_SUFFIXES.has(curSurface);
    const morphTag = isDerivSuffix
      ? 'deriv-suffix'
      : cur.pos === '名詞' && cur.pos_detail_1 === '形容動詞語幹'
      ? 'na-adj-stem'
      : cur.pos === '名詞' && cur.pos_detail_1 === 'サ変接続'
      ? 'vs-noun'
      : isParticle
      ? 'particle'
      : isCopula
      ? 'copula'
      : undefined;

    const isWord = !isPunct && curSurface.trim().length > 0;
    const baseForm =
      cur.basic_form && cur.basic_form !== '*' ? cur.basic_form : cur.surface_form;
    const rawReading = cur.reading ? katakanaToHiragana(cur.reading) : undefined;
    const standalonePos = `${cur.pos}${cur.pos_detail_1 ? ` (${cur.pos_detail_1})` : ''}`;

    const components = [
      {
        surface: cur.surface_form,
        basic: baseForm,
        pos: standalonePos,
        reading: rawReading,
        meaning: getJapaneseComponentMeaning(cur.surface_form, baseForm, standalonePos),
      },
    ];

    const furiganaSegments = buildFurigana(curSurface, rawReading, baseForm);

    merged.push({
      id: `tok-${i}-${safeStart}`,
      surface: curSurface,
      baseForm,
      reading: rawReading,
      furiganaSegments,
      partOfSpeech: isParticle
        ? 'Grammar Particle'
        : isCopula
        ? 'Copula'
        : cur.pos === '名詞'
        ? cur.pos_detail_1 === '形容動詞語幹'
          ? 'Na-adjective'
          : cur.pos_detail_1 === 'サ変接続'
          ? 'Noun (Suru verb)'
          : 'Noun'
        : cur.pos === '副詞'
        ? 'Adverb'
        : cur.pos === '接続詞'
        ? 'Conjunction'
        : cur.pos,
      isPunctuation: false,
      isWord,
      morphTag,
      components,
      startIndex: safeStart,
      endIndex: safeStart + curSurface.length,
    });

    cursor = safeStart + curSurface.length;
    i++;
  }

  return merged;
}

// Worker message listener
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', async (e: MessageEvent) => {
    const data = e.data || {};
    const { type, id, text, dicPath } = data;

    // Handle initialization request
    if (type === 'init') {
      try {
        await initTokenizer(dicPath || DEFAULT_DIC_PATH);
        self.postMessage({ type: 'ready' });
      } catch (err: any) {
        self.postMessage({
          type: 'init_error',
          error: err?.message || String(err),
          stack: err?.stack || '',
        });
      }
      return;
    }

    // Handle tokenization request
    if (type === 'tokenize' || (id && typeof text === 'string')) {
      if (!id || typeof text !== 'string') return;

      try {
        const tokenizer = await initTokenizer(dicPath || DEFAULT_DIC_PATH);
        const rawTokens: RawKuromojiToken[] = tokenizer.tokenize(text);
        const mergedTokens = mergeRawTokens(rawTokens, text);

        self.postMessage({
          type: 'tokenized',
          id,
          success: true,
          tokens: mergedTokens,
        });
      } catch (err: any) {
        self.postMessage({
          type: 'tokenized',
          id,
          success: false,
          error: err?.message || String(err),
        });
      }
    }
  });
}
