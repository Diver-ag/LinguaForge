export interface FuriganaSegment {
  text: string;
  ruby?: string;
}

export interface KanjiDetail {
  character: string;
  meanings: string[];
  readings: {
    on?: string[];
    kun?: string[];
    pinyin?: string[];
  };
  strokeCount?: number;
  radicals?: string[];
  frequencyRank?: number;
  jlptLevel?: string;
}

export interface ExampleSentence {
  original: string;
  translation: string;
  reading?: string;
}

export interface DictionaryEntry {
  id: string;
  word: string;
  readings: string[];
  meanings: string[];
  partsOfSpeech: string[];
  level?: string;
  frequencyRank?: number;
  frequencyBand?: string;
  priorityTags?: string[];
  priorityBadge?: string;
  isSampleFallback?: boolean;
  allEntries?: DictionaryEntry[];
  sourceKind?: 'dictionary' | 'names' | 'kanji' | 'kanji-levels' | 'sentences' | 'jlpt' | 'frequency' | 'other';
  sourceName?: string;
  importIds?: string[];
  groupedResults?: {
    words: DictionaryEntry[];
    names: DictionaryEntry[];
    kanji: DictionaryEntry[];
    examples: DictionaryEntry[];
  };
  furiganaSegments?: FuriganaSegment[];
  kanjiBreakdown?: KanjiDetail[];
  examples?: ExampleSentence[];
  grammarNotes?: string[];
  conjugatedForm?: string;
  grammarComponents?: { surface: string; pos: string; basic: string; reading?: string }[];
}

export interface Token {
  id: string;
  surface: string;
  baseForm: string;
  reading?: string;
  furiganaSegments?: FuriganaSegment[];
  partOfSpeech?: string;
  isPunctuation?: boolean;
  isWord: boolean;
  level?: string;
  frequencyRank?: number;
  startIndex: number;
  endIndex: number;
  conjugatedForm?: string;
  components?: { surface: string; pos: string; basic: string; reading?: string }[];
}

export interface DifficultyLevelSystem {
  id: string;
  name: string; // e.g. 'JLPT', 'CEFR', 'HSK', 'TOPIK'
  levels: {
    code: string; // e.g. 'N5', 'N4', 'N3', 'N2', 'N1'
    label: string; // e.g. 'N5 (Beginner)'
    color: string; // Tailwind color token or hex
    rankOrder: number; // 1 = easiest, higher = harder
  }[];
  defaultLevel: string;
}

export interface GrammarPoint {
  id: string;
  title: string;
  pattern: string;
  level?: string;
  explanation: string;
  examples: ExampleSentence[];
}

export interface PackAssetManifestItem {
  id: string;
  name: string;
  description: string;
  version: string;
  sizeBytes: number;
  sizeFormatted: string;
  url: string;
  checksum?: string;
  isCoreBundle?: boolean;
}

export interface LanguagePack {
  id: string;
  name: string;
  nativeName: string;
  flagEmoji: string;
  description: string;
  ocrCode: string;
  sttCode: string;
  ttsCode: string;
  levelSystem: DifficultyLevelSystem;
  assetsManifest: PackAssetManifestItem[];

  /** Whether this language renders ruby/furigana annotations above words (e.g. Japanese, Mandarin). */
  supportsRubyAnnotations?: boolean;
  /** Native test phrase used in Settings -> Speech voice testing. */
  sampleTestPhrase?: string;
  /** Default total pack download size in bytes for one-click install UI. */
  packSizeBytes?: number;
  /** Human-readable default download size (e.g. "4.8 MB"). */
  packSizeFormatted?: string;
  /** Current bundled/manifest version string. */
  packVersion?: string;
  /** Technical summary shown only when Developer Options is enabled. */
  packTokenizerLabel?: string;
  packSourceLabel?: string;

  // Core functions
  tokenize(text: string): Promise<Token[]>;
  lookup(word: string, lemma?: string): Promise<DictionaryEntry | null>;
  searchDictionary(query: string, limit?: number): Promise<DictionaryEntry[]>;
  getFrequency(word: string): number | null;
  getLevel(word: string): string | null;
  getReading(token: Token | string): { displayReading?: string; furiganaSegments?: FuriganaSegment[]; romanization?: string };
  lookupKanji?(character: string): Promise<KanjiDetail | null>;
  lookupGrammar(query: string): Promise<GrammarPoint[]>;
}

export function packSupportsRuby(pack: Pick<LanguagePack, 'id' | 'supportsRubyAnnotations'> | undefined | null): boolean {
  if (!pack) return true;
  if (typeof pack.supportsRubyAnnotations === 'boolean') {
    return pack.supportsRubyAnnotations;
  }
  return pack.id === 'ja' || pack.id === 'zh';
}
