import type { LanguagePack } from '../core/languagePack';
import { JapaneseLanguagePack } from './japanese';
import {
  CEFR_LEVEL_SYSTEM,
  HSK_LEVEL_SYSTEM,
  TOPIK_LEVEL_SYSTEM,
  createMultilingualLanguagePack,
} from './multilingualPack';

const GermanLanguagePack = createMultilingualLanguagePack({
  id: 'de',
  name: 'German',
  nativeName: 'Deutsch',
  flagEmoji: '🇩🇪',
  description:
    'German language pack with CEFR A1-C2 vocabulary, inflection stemming, and offline starter lexicon.',
  ocrCode: 'deu',
  sttCode: 'de-DE',
  ttsCode: 'de-DE',
  levelSystem: CEFR_LEVEL_SYSTEM,
  supportsRubyAnnotations: false,
  sampleTestPhrase: 'Guten Morgen! Wie geht es Ihnen heute?',
  packSizeBytes: 5452595,
  packSizeFormatted: '5.2 MB',
  packVersion: '1.0.0',
  packTokenizerLabel: 'Intl.Segmenter (de) + Inflection Stemmer',
  packSourceLabel: 'FreeDict / Wiktionary DE-EN + CEFR Index',
  assetsManifest: [
    {
      id: 'de-dict-core',
      name: 'German Core Lexicon',
      description: 'German-English dictionary with noun genders, cases, and CEFR levels.',
      version: '1.0.0',
      sizeBytes: 4194304,
      sizeFormatted: '4.0 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/de/dictionary.json.gz',
      isCoreBundle: true,
    },
    {
      id: 'de-freq-cefr',
      name: 'German Frequency & CEFR Index',
      description: 'Frequency bands and CEFR A1-C2 classifications.',
      version: '1.0.0',
      sizeBytes: 1258291,
      sizeFormatted: '1.2 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/de/frequency.json.gz',
    },
  ],
});

const FrenchLanguagePack = createMultilingualLanguagePack({
  id: 'fr',
  name: 'French',
  nativeName: 'Français',
  flagEmoji: '🇫🇷',
  description:
    "French language pack with apostrophe elision splitting (l'arbre), verb lemmatization, and CEFR A1-C2 levels.",
  ocrCode: 'fra',
  sttCode: 'fr-FR',
  ttsCode: 'fr-FR',
  levelSystem: CEFR_LEVEL_SYSTEM,
  supportsRubyAnnotations: false,
  sampleTestPhrase: "Bonjour ! Comment allez-vous aujourd'hui ?",
  packSizeBytes: 5138022,
  packSizeFormatted: '4.9 MB',
  packVersion: '1.0.0',
  packTokenizerLabel: 'Intl.Segmenter (fr) + Elision Splitter',
  packSourceLabel: 'FreeDict / Wiktionary FR-EN + CEFR Index',
  assetsManifest: [
    {
      id: 'fr-dict-core',
      name: 'French Core Lexicon',
      description: 'French-English dictionary with phonetic transcriptions and CEFR tags.',
      version: '1.0.0',
      sizeBytes: 3984588,
      sizeFormatted: '3.8 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/fr/dictionary.json.gz',
      isCoreBundle: true,
    },
    {
      id: 'fr-freq-cefr',
      name: 'French Frequency & CEFR Index',
      description: 'Frequency bands and CEFR A1-C2 classifications.',
      version: '1.0.0',
      sizeBytes: 1153434,
      sizeFormatted: '1.1 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/fr/frequency.json.gz',
    },
  ],
});

const ItalianLanguagePack = createMultilingualLanguagePack({
  id: 'it',
  name: 'Italian',
  nativeName: 'Italiano',
  flagEmoji: '🇮🇹',
  description:
    "Italian language pack with elision splitting (dell'acqua), verb conjugation lookup, and CEFR A1-C2 levels.",
  ocrCode: 'ita',
  sttCode: 'it-IT',
  ttsCode: 'it-IT',
  levelSystem: CEFR_LEVEL_SYSTEM,
  supportsRubyAnnotations: false,
  sampleTestPhrase: 'Buongiorno! Come sta oggi?',
  packSizeBytes: 4718592,
  packSizeFormatted: '4.5 MB',
  packVersion: '1.0.0',
  packTokenizerLabel: 'Intl.Segmenter (it) + Elision Splitter',
  packSourceLabel: 'FreeDict / Wiktionary IT-EN + CEFR Index',
  assetsManifest: [
    {
      id: 'it-dict-core',
      name: 'Italian Core Lexicon',
      description: 'Italian-English dictionary with pronunciations and CEFR tags.',
      version: '1.0.0',
      sizeBytes: 3670016,
      sizeFormatted: '3.5 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/it/dictionary.json.gz',
      isCoreBundle: true,
    },
    {
      id: 'it-freq-cefr',
      name: 'Italian Frequency & CEFR Index',
      description: 'Frequency bands and CEFR A1-C2 classifications.',
      version: '1.0.0',
      sizeBytes: 1048576,
      sizeFormatted: '1.0 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/it/frequency.json.gz',
    },
  ],
});

const PortugueseLanguagePack = createMultilingualLanguagePack({
  id: 'pt',
  name: 'Portuguese',
  nativeName: 'Português',
  flagEmoji: '🇧🇷',
  description:
    'Portuguese language pack (pt-BR) with plural/verb stemming, IPA readings, and CEFR A1-C2 levels.',
  ocrCode: 'por',
  sttCode: 'pt-BR',
  ttsCode: 'pt-BR',
  levelSystem: CEFR_LEVEL_SYSTEM,
  supportsRubyAnnotations: false,
  sampleTestPhrase: 'Bom dia! Como você está hoje?',
  packSizeBytes: 4823449,
  packSizeFormatted: '4.6 MB',
  packVersion: '1.0.0',
  packTokenizerLabel: 'Intl.Segmenter (pt) + Inflection Stemmer',
  packSourceLabel: 'FreeDict / Wiktionary PT-EN + CEFR Index',
  assetsManifest: [
    {
      id: 'pt-dict-core',
      name: 'Portuguese Core Lexicon',
      description: 'Portuguese-English dictionary with IPA readings and CEFR tags.',
      version: '1.0.0',
      sizeBytes: 3774873,
      sizeFormatted: '3.6 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/pt/dictionary.json.gz',
      isCoreBundle: true,
    },
    {
      id: 'pt-freq-cefr',
      name: 'Portuguese Frequency & CEFR Index',
      description: 'Frequency bands and CEFR A1-C2 classifications.',
      version: '1.0.0',
      sizeBytes: 1048576,
      sizeFormatted: '1.0 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/pt/frequency.json.gz',
    },
  ],
});

const TurkishLanguagePack = createMultilingualLanguagePack({
  id: 'tr',
  name: 'Turkish',
  nativeName: 'Türkçe',
  flagEmoji: '🇹🇷',
  description:
    'Turkish language pack with agglutinative vowel-harmony suffix stripping, consonant mutation lookup, and CEFR A1-C2 levels.',
  ocrCode: 'tur',
  sttCode: 'tr-TR',
  ttsCode: 'tr-TR',
  levelSystem: CEFR_LEVEL_SYSTEM,
  supportsRubyAnnotations: false,
  sampleTestPhrase: 'Günaydın! Bugün nasılsınız?',
  packSizeBytes: 4508876,
  packSizeFormatted: '4.3 MB',
  packVersion: '1.0.0',
  packTokenizerLabel: 'Intl.Segmenter (tr) + Agglutinative Stemmer',
  packSourceLabel: 'FreeDict / Wiktionary TR-EN + CEFR Index',
  assetsManifest: [
    {
      id: 'tr-dict-core',
      name: 'Turkish Core Lexicon',
      description: 'Turkish-English dictionary with vowel harmony stem normalization.',
      version: '1.0.0',
      sizeBytes: 3460300,
      sizeFormatted: '3.3 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/tr/dictionary.json.gz',
      isCoreBundle: true,
    },
    {
      id: 'tr-freq-cefr',
      name: 'Turkish Frequency & CEFR Index',
      description: 'Frequency bands and CEFR A1-C2 classifications.',
      version: '1.0.0',
      sizeBytes: 1048576,
      sizeFormatted: '1.0 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/tr/frequency.json.gz',
    },
  ],
});

const DutchLanguagePack = createMultilingualLanguagePack({
  id: 'nl',
  name: 'Dutch',
  nativeName: 'Nederlands',
  flagEmoji: '🇳🇱',
  description:
    'Dutch language pack with verb/noun inflection lookup and CEFR A1-C2 levels.',
  ocrCode: 'nld',
  sttCode: 'nl-NL',
  ttsCode: 'nl-NL',
  levelSystem: CEFR_LEVEL_SYSTEM,
  supportsRubyAnnotations: false,
  sampleTestPhrase: 'Goedemorgen! Hoe gaat het vandaag?',
  packSizeBytes: 4613734,
  packSizeFormatted: '4.4 MB',
  packVersion: '1.0.0',
  packTokenizerLabel: 'Intl.Segmenter (nl) + Inflection Stemmer',
  packSourceLabel: 'FreeDict / Wiktionary NL-EN + CEFR Index',
  assetsManifest: [
    {
      id: 'nl-dict-core',
      name: 'Dutch Core Lexicon',
      description: 'Dutch-English dictionary with pronunciations and CEFR tags.',
      version: '1.0.0',
      sizeBytes: 3565158,
      sizeFormatted: '3.4 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/nl/dictionary.json.gz',
      isCoreBundle: true,
    },
    {
      id: 'nl-freq-cefr',
      name: 'Dutch Frequency & CEFR Index',
      description: 'Frequency bands and CEFR A1-C2 classifications.',
      version: '1.0.0',
      sizeBytes: 1048576,
      sizeFormatted: '1.0 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/nl/frequency.json.gz',
    },
  ],
});

const KoreanLanguagePack = createMultilingualLanguagePack({
  id: 'ko',
  name: 'Korean',
  nativeName: '한국어',
  flagEmoji: '🇰🇷',
  description:
    'Korean language pack with particle/ending stripping, romanization readings, and TOPIK 1-6 difficulty levels.',
  ocrCode: 'kor',
  sttCode: 'ko-KR',
  ttsCode: 'ko-KR',
  levelSystem: TOPIK_LEVEL_SYSTEM,
  supportsRubyAnnotations: false,
  sampleTestPhrase: '안녕하세요. 오늘 날씨가 정말 좋네요.',
  packSizeBytes: 6081740,
  packSizeFormatted: '5.8 MB',
  packVersion: '1.0.0',
  packTokenizerLabel: 'Intl.Segmenter (ko) + Particle & Ending Stemmer',
  packSourceLabel: 'Wiktionary KO-EN + TOPIK Level List',
  assetsManifest: [
    {
      id: 'ko-dict-core',
      name: 'Korean Core Lexicon',
      description: 'Korean-English vocabulary with Hangul headwords and romanization.',
      version: '1.0.0',
      sizeBytes: 4718592,
      sizeFormatted: '4.5 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/ko/dictionary.json.gz',
      isCoreBundle: true,
    },
    {
      id: 'ko-freq-topik',
      name: 'Korean Frequency & TOPIK Index',
      description: 'Frequency bands and TOPIK 1-6 classifications.',
      version: '1.0.0',
      sizeBytes: 1363148,
      sizeFormatted: '1.3 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/ko/frequency.json.gz',
    },
  ],
});

const MandarinLanguagePack = createMultilingualLanguagePack({
  id: 'zh',
  name: 'Mandarin Chinese',
  nativeName: '中文',
  flagEmoji: '🇨🇳',
  description:
    'Mandarin Chinese pack with word segmentation, per-character tone-marked Pinyin ruby annotations, and HSK 1-6 levels.',
  ocrCode: 'chi_sim',
  sttCode: 'zh-CN',
  ttsCode: 'zh-CN',
  levelSystem: HSK_LEVEL_SYSTEM,
  supportsRubyAnnotations: true,
  sampleTestPhrase: '你好，今天的天气非常好。',
  packSizeBytes: 7549747,
  packSizeFormatted: '7.2 MB',
  packVersion: '1.0.0',
  packTokenizerLabel: 'Intl.Segmenter (zh) + pinyin-pro Ruby Engine',
  packSourceLabel: 'CC-CEDICT Starter + HSK 1-6 Index',
  assetsManifest: [
    {
      id: 'zh-dict-core',
      name: 'Mandarin CC-CEDICT Core',
      description: 'Simplified Chinese vocabulary with tone-marked Pinyin and English glosses.',
      version: '1.0.0',
      sizeBytes: 5976883,
      sizeFormatted: '5.7 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/zh/dictionary.json.gz',
      isCoreBundle: true,
    },
    {
      id: 'zh-freq-hsk',
      name: 'Mandarin Frequency & HSK Index',
      description: 'Frequency bands and HSK 1-6 classifications.',
      version: '1.0.0',
      sizeBytes: 1572864,
      sizeFormatted: '1.5 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/zh/frequency.json.gz',
    },
  ],
});

const SpanishLanguagePack = createMultilingualLanguagePack({
  id: 'es',
  name: 'Spanish',
  nativeName: 'Español',
  flagEmoji: '🇪🇸',
  description:
    'Spanish language pack with CEFR A1-C2 vocabulary, verb/plural stemming, and offline starter lexicon.',
  ocrCode: 'spa',
  sttCode: 'es-ES',
  ttsCode: 'es-ES',
  levelSystem: CEFR_LEVEL_SYSTEM,
  supportsRubyAnnotations: false,
  sampleTestPhrase: '¡Buenos días! ¿Cómo estás hoy?',
  packSizeBytes: 5033164,
  packSizeFormatted: '4.8 MB',
  packVersion: '1.0.0',
  packTokenizerLabel: 'Intl.Segmenter (es) + Inflection Stemmer',
  packSourceLabel: 'FreeDict / Wiktionary ES-EN + CEFR Index',
  assetsManifest: [
    {
      id: 'es-dict-core',
      name: 'Spanish Core Lexicon',
      description: 'Spanish-English dictionary with verb conjugations, pronunciations, and CEFR tags.',
      version: '1.0.0',
      sizeBytes: 3984588,
      sizeFormatted: '3.8 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/es/dictionary.json.gz',
      isCoreBundle: true,
    },
    {
      id: 'es-freq-cefr',
      name: 'Spanish Frequency & CEFR Index',
      description: 'Frequency bands and CEFR A1-C2 classifications.',
      version: '1.0.0',
      sizeBytes: 1048576,
      sizeFormatted: '1.0 MB',
      url: 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/es/frequency.json.gz',
    },
  ],
});

const registry = new Map<string, LanguagePack>();

registry.set(JapaneseLanguagePack.id, JapaneseLanguagePack);
registry.set(GermanLanguagePack.id, GermanLanguagePack);
registry.set(FrenchLanguagePack.id, FrenchLanguagePack);
registry.set(ItalianLanguagePack.id, ItalianLanguagePack);
registry.set(PortugueseLanguagePack.id, PortugueseLanguagePack);
registry.set(TurkishLanguagePack.id, TurkishLanguagePack);
registry.set(DutchLanguagePack.id, DutchLanguagePack);
registry.set(KoreanLanguagePack.id, KoreanLanguagePack);
registry.set(MandarinLanguagePack.id, MandarinLanguagePack);
registry.set(SpanishLanguagePack.id, SpanishLanguagePack);

export function getLanguagePack(id: string): LanguagePack {
  const pack = registry.get(id);
  if (!pack) {
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
