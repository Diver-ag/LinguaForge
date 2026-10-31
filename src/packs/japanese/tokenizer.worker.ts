// Shims for UMD compatibility in worker before any imports
if (typeof self !== 'undefined') {
  (self as any).global = self;
  (self as any).window = self;
  if (!(self as any).Zlib) {
    (self as any).Zlib = {};
  }
}

import { katakanaToHiragana, buildFurigana } from './kanaUtils';

let tokenizerPromise: Promise<any> | null = null;
let tokenizerInstance: any = null;

const DEFAULT_DIC_PATH = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';

async function initTokenizer(dicPath = DEFAULT_DIC_PATH): Promise<any> {
  if (tokenizerInstance) return tokenizerInstance;
  if (tokenizerPromise) return tokenizerPromise;

  tokenizerPromise = new Promise(async (resolve, reject) => {
    try {
      // Dynamic import ensures (self as any).global = self is strictly evaluated first
      const kuromojiModule = await import('kuromoji');
      const kuromoji = (kuromojiModule.default || kuromojiModule) as any;

      kuromoji.builder({ dicPath }).build((err: any, tokenizer: any) => {
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

    // Check if Head is a Verb (動詞) or Adjective (形容詞)
    if (cur.pos === '動詞' || cur.pos === '形容詞') {
      const group: RawKuromojiToken[] = [cur];
      let j = i + 1;

      while (j < rawTokens.length) {
        const next = rawTokens[j];

        // 1. Chained auxiliary verbs (助動詞: ます, た, だ, ない, ぬ, せる, れる, たい, etc.)
        if (next.pos === '助動詞') {
          group.push(next);
          j++;
          continue;
        }

        // 2. Chained conjunctive particles (て / で) followed by auxiliary / subsidiary verb
        if (
          next.pos === '助詞' &&
          (next.surface_form === 'て' || next.surface_form === 'で')
        ) {
          if (
            j + 1 < rawTokens.length &&
            (rawTokens[j + 1].pos === '動詞' || rawTokens[j + 1].pos === '助動詞')
          ) {
            group.push(next);
            group.push(rawTokens[j + 1]);
            j += 2;
            continue;
          }
          // Standalone trailing te-form: e.g. 食べて
          group.push(next);
          j++;
          continue;
        }

        break;
      }

      const surface = group.map((t) => t.surface_form).join('');
      const baseForm =
        cur.basic_form && cur.basic_form !== '*' ? cur.basic_form : cur.surface_form;

      const rawReadingKana = group.map((t) => t.reading || '').join('');
      const reading = katakanaToHiragana(rawReadingKana);

      // Determine conjugated description
      const auxParts = group.slice(1).map((t) => t.surface_form).join('');
      const conjugatedForm = auxParts ? `Form: ${auxParts}` : undefined;

      const components = group.map((t) => ({
        surface: t.surface_form,
        basic: t.basic_form && t.basic_form !== '*' ? t.basic_form : t.surface_form,
        pos: `${t.pos}${t.pos_detail_1 ? ` (${t.pos_detail_1})` : ''}`,
        reading: t.reading ? katakanaToHiragana(t.reading) : undefined,
      }));

      // Generate furigana segments if surface contains kanji
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
        components,
        startIndex: safeStart,
        endIndex: safeStart + surface.length,
      });

      cursor = safeStart + surface.length;
      i = j;
      continue;
    }

    // Standalone Particle, Noun, Adverb, Conjunction, etc.
    const isParticle = cur.pos === '助詞';
    const isWord = !isPunct && curSurface.trim().length > 0;
    const baseForm =
      cur.basic_form && cur.basic_form !== '*' ? cur.basic_form : cur.surface_form;
    const rawReading = cur.reading ? katakanaToHiragana(cur.reading) : undefined;

    const components = [
      {
        surface: cur.surface_form,
        basic: baseForm,
        pos: `${cur.pos}${cur.pos_detail_1 ? ` (${cur.pos_detail_1})` : ''}`,
        reading: rawReading,
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
        ? 'Particle'
        : cur.pos === '名詞'
        ? 'Noun'
        : cur.pos === '副詞'
        ? 'Adverb'
        : cur.pos === '接続詞'
        ? 'Conjunction'
        : cur.pos,
      isPunctuation: false,
      isWord,
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
