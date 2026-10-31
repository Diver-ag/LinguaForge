import type { LanguagePack } from '../core/languagePack';
import { JapaneseLanguagePack } from './japanese';

const registry = new Map<string, LanguagePack>();

// Register default bundled packs
registry.set(JapaneseLanguagePack.id, JapaneseLanguagePack);

// Optional scaffolding pack to demonstrate multi-language extensibility (e.g. Spanish with CEFR)
const SpanishLanguagePack: LanguagePack = {
  id: 'es',
  name: 'Spanish',
  nativeName: 'Español',
  flagEmoji: '🇪🇸',
  description: 'Spanish Language Pack featuring CEFR difficulty levels (A1-C2), syllabic stress identification, and conjugations.',
  ocrCode: 'spa',
  sttCode: 'es-ES',
  ttsCode: 'es-ES',
  levelSystem: {
    id: 'cefr',
    name: 'CEFR',
    levels: [
      { code: 'A1', label: 'A1 (Breakthrough)', color: 'emerald', rankOrder: 1 },
      { code: 'A2', label: 'A2 (Waystage)', color: 'sky', rankOrder: 2 },
      { code: 'B1', label: 'B1 (Threshold)', color: 'amber', rankOrder: 3 },
      { code: 'B2', label: 'B2 (Vantage)', color: 'indigo', rankOrder: 4 },
      { code: 'C1', label: 'C1 (Advanced)', color: 'purple', rankOrder: 5 },
      { code: 'C2', label: 'C2 (Mastery)', color: 'rose', rankOrder: 6 },
    ],
    defaultLevel: 'A1',
  },
  assetsManifest: [
    {
      id: 'es-wiktionary-core',
      name: 'Spanish Wiktionary Lexicon',
      description: 'Over 90,000 Spanish lemmas with CEFR levels and gender annotations.',
      version: '1.0.0',
      sizeBytes: 11534336,
      sizeFormatted: '11.0 MB',
      url: 'https://data.linguaforge.app/packs/es/lexicon.json.gz',
      isCoreBundle: true,
    },
  ],
  async tokenize(text: string) {
    const rawTokens = text.split(/([\s,.;:!?¡¿"'\(\)\[\]{}—]+)/);
    let index = 0;
    return rawTokens.map((raw, i) => {
      const isWord = /[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/.test(raw);
      const isPunctuation = !isWord;
      const tok = {
        id: `es-${i}-${index}`,
        surface: raw,
        baseForm: raw.toLowerCase(),
        isWord,
        isPunctuation,
        startIndex: index,
        endIndex: index + raw.length,
      };
      index += raw.length;
      return tok;
    });
  },
  async lookup(word: string) {
    return {
      id: `es-${word}`,
      word,
      readings: [word],
      meanings: [`Spanish definition for "${word}"`],
      partsOfSpeech: ['Word'],
      level: 'A1',
      frequencyRank: 500,
    };
  },
  async searchDictionary(query: string) {
    return [];
  },
  getFrequency() {
    return null;
  },
  getLevel() {
    return 'A1';
  },
  getReading(token) {
    const s = typeof token === 'string' ? token : token.surface;
    return { displayReading: s, romanization: s };
  },
  async lookupGrammar() {
    return [];
  },
};

registry.set(SpanishLanguagePack.id, SpanishLanguagePack);

export function getLanguagePack(id: string): LanguagePack {
  const pack = registry.get(id);
  if (!pack) {
    // Default fallback to Japanese
    return JapaneseLanguagePack;
  }
  return pack;
}

export function getAllLanguagePacks(): LanguagePack[] {
  return Array.from(registry.values());
}

export function registerLanguagePack(pack: LanguagePack): void {
  registry.set(pack.id, pack);
}
