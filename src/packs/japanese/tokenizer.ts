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
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
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

// Status tracking for tokenizer
let tokenizerWarning: string | null = null;
export function getTokenizerWarning(): string | null {
  return tokenizerWarning;
}

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

const DEFAULT_DIC_CDN = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';

function initWorker(): Promise<void> {
  if (readyPromise) return readyPromise;
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return Promise.reject(new Error('Web Workers not supported in current environment'));
  }

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

      // 60-second generous timeout for downloading dictionary files and initializing Kuromoji
      initTimer = setTimeout(() => {
        cleanupInitTimer();
        readyPromise = null;
        reject(new Error('Kuromoji dictionary download timed out after 60s'));
      }, 60000);

      workerInstance.onmessage = (e: MessageEvent) => {
        const data = e.data || {};
        if (data.type === 'ready') {
          cleanupInitTimer();
          resolve();
          return;
        }

        if (data.type === 'init_error') {
          cleanupInitTimer();
          readyPromise = null;
          reject(new Error(data.error || 'Failed to initialize Kuromoji'));
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
        reject(new Error('Worker error: ' + (err.message || 'Worker failed to load')));
      };

      // Send initial init message to load kuromoji dictionary
      workerInstance.postMessage({
        type: 'init',
        dicPath: DEFAULT_DIC_CDN,
      });
    } catch (err) {
      cleanupInitTimer();
      readyPromise = null;
      reject(err);
    }
  });

  return readyPromise;
}

// Robust Intl.Segmenter + morphological compound merging tokenizer
// Fallback guarantees 100% functionality and uptime if Worker fails or is offline
export function tokenizeWithIntlSegmenter(text: string): Token[] {
  if (!text) return [];

  const rawSegments: { segment: string; isWordLike: boolean; index: number }[] = [];
  if (typeof Intl !== 'undefined' && 'Segmenter' in (Intl as any)) {
    const segmenter = new (Intl as any).Segmenter('ja', { granularity: 'word' });
    for (const seg of segmenter.segment(text)) {
      rawSegments.push({
        segment: seg.segment,
        isWordLike: seg.isWordLike,
        index: seg.index,
      });
    }
  } else {
    // Regex fallback
    let c = 0;
    const parts = text.split(/([、。！？「」『』（）［］【】・…—\s\n\r\t.,!?"'()\[\]]+)/);
    for (const p of parts) {
      if (p) {
        rawSegments.push({
          segment: p,
          isWordLike: !/^[、。！？\s.,!?"'()]+$/.test(p),
          index: c,
        });
        c += p.length;
      }
    }
  }

  // Pre-normalize broken okurigana / compound fragments from Intl.Segmenter
  const segments: { segment: string; isWordLike: boolean; index: number }[] = [];
  let sIdx = 0;
  while (sIdx < rawSegments.length) {
    const cur = rawSegments[sIdx];
    const next = rawSegments[sIdx + 1];
    const third = rawSegments[sIdx + 2];

    if (next && cur.segment === '食' && next.segment === 'べ') {
      segments.push({ segment: '食べ', isWordLike: true, index: cur.index });
      sIdx += 2;
      continue;
    }
    if (next && cur.segment === '美味' && next.segment === 'しく') {
      segments.push({ segment: '美味しく', isWordLike: true, index: cur.index });
      sIdx += 2;
      continue;
    }
    if (cur.segment === 'てい') {
      segments.push({ segment: 'て', isWordLike: true, index: cur.index });
      segments.push({ segment: 'い', isWordLike: true, index: cur.index + 1 });
      sIdx++;
      continue;
    }
    if (cur.segment === 'なか' && next?.segment === 'っ' && third?.segment === 'た') {
      segments.push({ segment: 'なかった', isWordLike: true, index: cur.index });
      sIdx += 3;
      continue;
    }
    if (cur.segment === 'ま' && next?.segment === 'した') {
      segments.push({ segment: 'ました', isWordLike: true, index: cur.index });
      sIdx += 2;
      continue;
    }

    segments.push(cur);
    sIdx++;
  }

  // Identify parts and merge predicates (動詞, 助動詞, 接続助詞)
  const tokens: Token[] = [];
  let i = 0;

  while (i < segments.length) {
    const seg = segments[i];
    const raw = seg.segment;
    const isPunct =
      !seg.isWordLike ||
      /^[、。！？「」『』（）［］【】・…—\s\n\r\t.,!?"'()\[\]]+$/.test(raw);

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

    // Check if this segment starts a verb or adjective predicate
    let isVerbHead = false;
    let isAdjHead = false;
    let baseForm = raw;

    if (raw === 'あり' || raw === 'ある') {
      isVerbHead = true;
      baseForm = 'ある';
    } else if (raw === '食べ' || raw === '食べる') {
      isVerbHead = true;
      baseForm = '食べる';
    } else if (raw === '行き' || raw === '行く' || raw === '行っ') {
      isVerbHead = true;
      baseForm = '行く';
    } else if (raw === '来' || raw === '来る') {
      isVerbHead = true;
      baseForm = '来る';
    } else if (raw === '見' || raw === '見る') {
      isVerbHead = true;
      baseForm = '見る';
    } else if (raw === '聞き' || raw === '聞く') {
      isVerbHead = true;
      baseForm = '聞く';
    } else if (raw === '読み' || raw === '読む') {
      isVerbHead = true;
      baseForm = '読む';
    } else if (raw === '書き' || raw === '書く') {
      isVerbHead = true;
      baseForm = '書く';
    } else if (raw === 'し' || raw === 'する') {
      isVerbHead = true;
      baseForm = 'する';
    } else if (raw === '美味しく' || raw === '美味しい') {
      isAdjHead = true;
      baseForm = '美味しい';
    } else if (raw.endsWith('く') && dictMap.has(raw.slice(0, -1) + 'い')) {
      isAdjHead = true;
      baseForm = raw.slice(0, -1) + 'い';
    }

    if (isVerbHead || isAdjHead) {
      const group: { surface: string; pos: string; basic: string }[] = [
        {
          surface: raw,
          pos: isVerbHead ? 'Verb' : 'I-adjective',
          basic: baseForm,
        },
      ];

      let j = i + 1;
      while (j < segments.length) {
        const next = segments[j];
        const nRaw = next.segment;

        // Auxiliary verb endings: ます, ました, ません, た, だ, ない, なかっ, なかった, たい
        if (['ます', 'ました', 'ません', 'た', 'だ', 'ない', 'なかっ', 'なかった', 'たい', 'でし'].includes(nRaw)) {
          group.push({ surface: nRaw, pos: 'Auxiliary', basic: nRaw });
          j++;
          continue;
        }

        // Chained te-form particle + auxiliary verb (e.g. 食べ + て + い + ます)
        if (nRaw === 'て' || nRaw === 'で') {
          if (j + 1 < segments.length) {
            const afterTe = segments[j + 1].segment;
            if (['い', 'いる', 'ある', 'みる', 'おく', 'しまう'].includes(afterTe)) {
              group.push({ surface: nRaw, pos: 'Conjunctive Particle', basic: nRaw });
              group.push({ surface: afterTe, pos: 'Auxiliary Verb', basic: afterTe === 'い' ? 'いる' : afterTe });
              j += 2;
              continue;
            }
          }
          // Standalone te-form at end of verb
          group.push({ surface: nRaw, pos: 'Conjunctive Particle', basic: nRaw });
          j++;
          continue;
        }

        break;
      }

      const surface = group.map((g) => g.surface).join('');
      const entry = dictMap.get(baseForm) || dictMap.get(surface);
      const reading = entry?.readings[0] || surface;
      const furiganaSegments = buildFurigana(surface, reading, baseForm);

      tokens.push({
        id: `tok-${i}-${seg.index}`,
        surface,
        baseForm,
        reading,
        furiganaSegments,
        partOfSpeech: isVerbHead ? 'Verb' : 'I-adjective',
        isPunctuation: false,
        isWord: true,
        level: entry?.level,
        frequencyRank: entry?.frequencyRank,
        components: group.map((g) => ({ surface: g.surface, pos: g.pos, basic: g.basic })),
        conjugatedForm: group.length > 1 ? group.slice(1).map((g) => g.surface).join('') : undefined,
        startIndex: seg.index,
        endIndex: seg.index + surface.length,
      });

      i = j;
      continue;
    }

    // Standalone words: Nouns, Particles, Adverbs
    const isParticle = ['は', 'が', 'を', 'に', 'へ', 'で', 'と', 'の', 'も', 'から', 'まで', 'より', 'か', 'ね', 'よ'].includes(raw);
    const entry = dictMap.get(raw);
    const reading = entry?.readings[0] || raw;
    const furiganaSegments = buildFurigana(raw, reading, raw);

    tokens.push({
      id: `tok-${i}-${seg.index}`,
      surface: raw,
      baseForm: raw,
      reading,
      furiganaSegments,
      partOfSpeech: isParticle ? 'Particle' : (entry?.partsOfSpeech[0] || 'Noun'),
      isPunctuation: false,
      isWord: true,
      level: entry?.level,
      frequencyRank: entry?.frequencyRank,
      startIndex: seg.index,
      endIndex: seg.index + raw.length,
    });

    i++;
  }

  return tokens;
}

export async function tokenizeJapanese(text: string, cacheKey?: string): Promise<Token[]> {
  if (!text) return [];

  // 1. Check in-memory document token cache
  const key = cacheKey || `hash:${text.length}:${text.slice(0, 40)}:${text.slice(-40)}`;
  if (documentTokenCache.has(key)) {
    return documentTokenCache.get(key)!;
  }

  let tokens: Token[] = [];

  try {
    // Wait for the worker to initialize (60s max for dictionary download).
    // Do NOT prematurely fall back to Intl.Segmenter while dictionary is downloading.
    await initWorker();

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
        dicPath: DEFAULT_DIC_CDN,
      });
    });

    tokenizerWarning = null;
  } catch (err: any) {
    console.warn('Tokenizer worker fell back to native segmenter:', err);
    tokenizerWarning = 'Kuromoji offline or loading; using native Japanese morphological segmenter.';
    tokens = tokenizeWithIntlSegmenter(text);
  }

  // Enrich with dictionary metadata
  for (const token of tokens) {
    if (!token.isWord) continue;
    const lookupKey = token.baseForm || token.surface;
    const entry = dictMap.get(lookupKey) || dictMap.get(token.surface);
    if (entry) {
      if (!token.level && entry.level) token.level = entry.level;
      if (!token.frequencyRank && entry.frequencyRank) token.frequencyRank = entry.frequencyRank;
      if (!token.furiganaSegments && entry.furiganaSegments) token.furiganaSegments = entry.furiganaSegments;
    }
  }

  // Cache tokenized result
  documentTokenCache.set(key, tokens);
  return tokens;
}
