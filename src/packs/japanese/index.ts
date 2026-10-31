import type {
  DictionaryEntry,
  DifficultyLevelSystem,
  GrammarPoint,
  KanjiDetail,
  LanguagePack,
  PackAssetManifestItem,
  Token,
} from '../../core/languagePack';
import { JAPANESE_DICTIONARY_SAMPLE } from './dictionaryData';
import { JAPANESE_GRAMMAR_DATABASE } from './grammarData';
import { getKanjiBreakdown, JAPANESE_KANJI_DATABASE } from './kanjiData';
import { hiraganaToRomaji, tokenizeJapanese } from './tokenizer';

const JLPT_LEVEL_SYSTEM: DifficultyLevelSystem = {
  id: 'jlpt',
  name: 'JLPT',
  levels: [
    { code: 'N5', label: 'JLPT N5 (Beginner)', color: 'emerald', rankOrder: 1 },
    { code: 'N4', label: 'JLPT N4 (Elementary)', color: 'sky', rankOrder: 2 },
    { code: 'N3', label: 'JLPT N3 (Intermediate)', color: 'amber', rankOrder: 3 },
    { code: 'N2', label: 'JLPT N2 (Upper Intermediate)', color: 'indigo', rankOrder: 4 },
    { code: 'N1', label: 'JLPT N1 (Advanced)', color: 'rose', rankOrder: 5 },
  ],
  defaultLevel: 'N5',
};

const ASSETS_MANIFEST: PackAssetManifestItem[] = [
  {
    id: 'jmdict-core',
    name: 'JMdict Comprehensive Vocabulary',
    description: '180,000+ Japanese-English entries with part of speech tags, dialect markings, and JLPT levels.',
    version: '1.0.4',
    sizeBytes: 15728640,
    sizeFormatted: '15.0 MB',
    url: 'https://data.linguaforge.app/packs/ja/jmdict.json.gz',
    isCoreBundle: true,
  },
  {
    id: 'kanjidic2-db',
    name: 'KANJIDIC2 & KRADFILE Kanji Database',
    description: '13,108 kanji characters with on/kun readings, English meanings, radicals, stroke orders, and frequency ranks.',
    version: '2.1.0',
    sizeBytes: 8388608,
    sizeFormatted: '8.0 MB',
    url: 'https://data.linguaforge.app/packs/ja/kanjidic2.json.gz',
  },
  {
    id: 'tatoeba-sentences',
    name: 'Tatoeba Sentences & Context Pairs',
    description: '210,000+ real-world example sentences with verified English translations and furigana.',
    version: '1.2.0',
    sizeBytes: 12582912,
    sizeFormatted: '12.0 MB',
    url: 'https://data.linguaforge.app/packs/ja/tatoeba_ja_en.json.gz',
  },
  {
    id: 'kuromoji-dict',
    name: 'Kuromoji Morphological Dictionary (IPADIC)',
    description: 'WASM-accelerated morphological analyzer dictionary for nuanced word boundaries and pitch-accent support.',
    version: '0.1.2',
    sizeBytes: 18874368,
    sizeFormatted: '18.0 MB',
    url: 'https://data.linguaforge.app/packs/ja/kuromoji_dict.bin',
  },
];

export const JapaneseLanguagePack: LanguagePack = {
  id: 'ja',
  name: 'Japanese',
  nativeName: '日本語',
  flagEmoji: '🇯🇵',
  description: 'Complete Japanese learning pack with morphological tokenization, JLPT N5-N1 levels, furigana generation, KANJIDIC2 breakdown, and Tatoeba contextual sentences.',
  ocrCode: 'jpn',
  sttCode: 'ja-JP',
  ttsCode: 'ja-JP',
  levelSystem: JLPT_LEVEL_SYSTEM,
  assetsManifest: ASSETS_MANIFEST,

  async tokenize(text: string): Promise<Token[]> {
    return tokenizeJapanese(text);
  },

  async lookup(word: string, lemma?: string): Promise<DictionaryEntry | null> {
    const cleanWord = word.trim();
    const cleanLemma = lemma?.trim();

    // 1. Look up lemma (dictionary form) first if provided
    let foundEntry: DictionaryEntry | null = null;
    if (cleanLemma) {
      foundEntry =
        JAPANESE_DICTIONARY_SAMPLE.find(
          (e) => e.word === cleanLemma || e.readings.includes(cleanLemma)
        ) || null;
    }

    // 2. Fallback: look up surface form
    if (!foundEntry) {
      foundEntry =
        JAPANESE_DICTIONARY_SAMPLE.find(
          (e) => e.word === cleanWord || e.readings.includes(cleanWord)
        ) || null;
    }

    // 3. Fallback: substring match
    if (!foundEntry) {
      foundEntry =
        JAPANESE_DICTIONARY_SAMPLE.find(
          (e) => cleanWord.includes(e.word) || (cleanLemma && cleanLemma.includes(e.word))
        ) || null;
    }

    // 4. Fallback: check if single kanji in kanji database
    if (!foundEntry && cleanWord.length === 1 && JAPANESE_KANJI_DATABASE[cleanWord]) {
      const k = JAPANESE_KANJI_DATABASE[cleanWord];
      return {
        id: `kanji-${cleanWord}`,
        word: cleanWord,
        readings: [...(k.readings.on || []), ...(k.readings.kun || [])],
        meanings: k.meanings,
        partsOfSpeech: ['Kanji'],
        level: k.jlptLevel,
        frequencyRank: k.frequencyRank,
        kanjiBreakdown: [k],
      };
    }

    if (foundEntry) {
      if (cleanLemma && cleanLemma !== cleanWord) {
        return {
          ...foundEntry,
          conjugatedForm: cleanWord,
        };
      }
      return foundEntry;
    }

    return null;
  },

  async searchDictionary(query: string, limit = 20): Promise<DictionaryEntry[]> {
    const q = query.toLowerCase().trim();
    if (!q) return JAPANESE_DICTIONARY_SAMPLE.slice(0, limit);

    return JAPANESE_DICTIONARY_SAMPLE.filter((entry) => {
      if (entry.word.includes(q)) return true;
      if (entry.readings.some((r) => r.toLowerCase().includes(q))) return true;
      if (entry.meanings.some((m) => m.toLowerCase().includes(q))) return true;
      return false;
    }).slice(0, limit);
  },

  getFrequency(word: string): number | null {
    const entry = JAPANESE_DICTIONARY_SAMPLE.find((e) => e.word === word);
    return entry?.frequencyRank ?? null;
  },

  getLevel(word: string): string | null {
    const entry = JAPANESE_DICTIONARY_SAMPLE.find((e) => e.word === word);
    return entry?.level ?? null;
  },

  getReading(token: Token | string) {
    const surface = typeof token === 'string' ? token : token.surface;
    const entry = JAPANESE_DICTIONARY_SAMPLE.find((e) => e.word === surface);
    const kanaReading = entry?.readings?.[0] || (typeof token !== 'string' ? token.reading : undefined);
    const romaji = kanaReading ? hiraganaToRomaji(kanaReading) : undefined;

    return {
      displayReading: kanaReading,
      furiganaSegments: entry?.furiganaSegments || (typeof token !== 'string' ? token.furiganaSegments : undefined),
      romanization: romaji,
    };
  },

  async lookupKanji(character: string): Promise<KanjiDetail | null> {
    const breakdown = getKanjiBreakdown(character);
    return breakdown.length > 0 ? breakdown[0] : null;
  },

  async lookupGrammar(query: string): Promise<GrammarPoint[]> {
    const q = query.trim().toLowerCase();
    if (!q) return JAPANESE_GRAMMAR_DATABASE;
    return JAPANESE_GRAMMAR_DATABASE.filter(
      (g) => g.title.toLowerCase().includes(q) || g.pattern.toLowerCase().includes(q) || g.explanation.toLowerCase().includes(q)
    );
  },
};
