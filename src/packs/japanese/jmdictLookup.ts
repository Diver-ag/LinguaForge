import { db, hasImportedDictionary, type JmdictEntryItem, type ImportKind } from '../../db/db';
import type { DictionaryEntry } from '../../core/languagePack';
import { JAPANESE_DICTIONARY_SAMPLE } from './dictionaryData';
import { JAPANESE_KANJI_DATABASE } from './kanjiData';
import { deriveFrequencyInfo } from './jmdictFrequency';
import {
  deinflectJapanese,
  explainJapaneseInflection,
  getJapaneseComponentMeaning,
  PROTECTED_JA_GRAMMAR_TOKENS,
  type ProtectedJaGrammarInfo,
} from './deinflector';

function buildProtectedGrammarEntry(
  info: ProtectedJaGrammarInfo,
  extraSample?: DictionaryEntry
): DictionaryEntry {
  return {
    id: `ja-grammar-${info.word}`,
    word: info.word,
    readings: [info.reading],
    meanings: info.meanings,
    partsOfSpeech: [info.badgeLabel],
    level: extraSample?.level || info.level,
    frequencyRank: extraSample?.frequencyRank,
    furiganaSegments: [{ text: info.word }],
    examples: extraSample?.examples,
    grammarNotes: extraSample?.grammarNotes || info.grammarNotes,
    sourceKind: 'dictionary',
    isSampleFallback: false,
  };
}

function determineEntryKind(item: JmdictEntryItem): ImportKind {
  if (item.kinds && item.kinds.length > 0) {
    if (item.kinds.includes('names')) return 'names';
    if (item.kinds.includes('kanji')) return 'kanji';
    if (item.kinds.includes('sentences')) return 'sentences';
    if (item.kinds.includes('dictionary')) return 'dictionary';
    return item.kinds[0];
  }
  // Detect by POS tags
  const allPos = item.senses.flatMap((s) => s.partsOfSpeech).join(' ').toLowerCase();
  if (/name|surname|given|place|person|unclass|company|organization/.test(allPos)) {
    return 'names';
  }
  if (allPos.includes('kanji')) return 'kanji';
  if (allPos.includes('sentence')) return 'sentences';
  return 'dictionary';
}

function mapJmdictItemToEntry(
  item: JmdictEntryItem,
  requestedSurface: string,
  requestedLemma?: string
): DictionaryEntry {
  const readings = item.kana.map((k) => k.text).filter(Boolean);
  const meanings = item.senses.flatMap((s) => s.glosses);
  const partsOfSpeech = Array.from(new Set(item.senses.flatMap((s) => s.partsOfSpeech)));
  const kind = determineEntryKind(item);
  const freqInfo = deriveFrequencyInfo(item.priorityTags || [], item.frequencyRank);

  const prelimExplained =
    requestedSurface && item.primaryWord !== requestedSurface
      ? explainJapaneseInflection(requestedSurface, item.primaryWord)
      : undefined;

  const isConjugated = Boolean(
    requestedSurface &&
      item.primaryWord !== requestedSurface &&
      ((requestedLemma && requestedLemma === item.primaryWord) ||
        (prelimExplained && prelimExplained.reasons.length > 0) ||
        deinflectJapanese(requestedSurface).some(
          (c) => c.reasons.length > 0 && (c.lemma === item.primaryWord || readings.includes(c.lemma))
        ))
  );

  const explained = isConjugated ? prelimExplained : undefined;

  return {
    id: `jmdict-${item.id}`,
    word: item.primaryWord,
    readings,
    meanings,
    partsOfSpeech: partsOfSpeech.length > 0 ? partsOfSpeech : [kind === 'names' ? 'Name' : 'Word'],
    frequencyBand: item.frequencyBand || freqInfo.frequencyBand,
    frequencyRank: item.frequencyRank || freqInfo.frequencyRank,
    priorityBadge: freqInfo.priorityBadge,
    level: item.jlptLevel,
    priorityTags: item.priorityTags,
    isSampleFallback: false,
    sourceKind: kind,
    importIds: item.importIds,
    conjugatedForm: isConjugated ? requestedSurface : undefined,
    inflectedSurface: isConjugated ? requestedSurface : undefined,
    grammarSuffix: explained?.grammarSuffix,
    grammarMeaning: explained?.grammarMeaning,
    grammarSteps: explained?.grammarSteps?.length ? explained.grammarSteps : undefined,
  };
}

export function lookupSampleDictionary(
  cleanWord: string,
  cleanLemma?: string
): DictionaryEntry | null {
  const protectedInfo = PROTECTED_JA_GRAMMAR_TOKENS[cleanWord];
  if (protectedInfo && (!cleanLemma || cleanLemma === cleanWord)) {
    const sampleHit = JAPANESE_DICTIONARY_SAMPLE.find((e) => e.word === cleanWord);
    return buildProtectedGrammarEntry(protectedInfo, sampleHit);
  }

  let found: DictionaryEntry | null = null;
  let matchedLemma = cleanLemma;

  if (cleanLemma) {
    found =
      JAPANESE_DICTIONARY_SAMPLE.find(
        (e) => e.word === cleanLemma || e.readings.includes(cleanLemma)
      ) || null;
  }
  if (!found) {
    found =
      JAPANESE_DICTIONARY_SAMPLE.find(
        (e) => e.word === cleanWord || e.readings.includes(cleanWord)
      ) || null;
  }
  if (!found && cleanWord) {
    const deinflected = deinflectJapanese(cleanWord);
    for (const cand of deinflected) {
      const hit = JAPANESE_DICTIONARY_SAMPLE.find(
        (e) => e.word === cand.lemma || e.readings.includes(cand.lemma)
      );
      if (hit) {
        found = hit;
        matchedLemma = hit.word;
        break;
      }
    }
  }
  if (!found) {
    found =
      JAPANESE_DICTIONARY_SAMPLE.find(
        (e) => cleanWord.includes(e.word) || (cleanLemma && cleanLemma.includes(e.word))
      ) || null;
  }
  if (!found && cleanWord) {
    const compGloss = getJapaneseComponentMeaning(cleanWord, cleanLemma);
    if (compGloss) {
      return {
        id: `ja-particle-${cleanWord}`,
        word: cleanWord,
        readings: [cleanWord],
        meanings: [compGloss],
        partsOfSpeech: ['Particle / Auxiliary'],
        sourceKind: 'dictionary',
        isSampleFallback: true,
      };
    }
  }
  if (!found && cleanWord.length === 1 && JAPANESE_KANJI_DATABASE[cleanWord]) {
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
      sourceKind: 'kanji',
      isSampleFallback: true,
    };
  }

  if (found) {
    const freqInfo = deriveFrequencyInfo(found.priorityTags || [], found.frequencyRank);
    const isConjugated =
      (matchedLemma && matchedLemma !== cleanWord && matchedLemma === found.word) ||
      (found.word !== cleanWord && !found.readings.includes(cleanWord));
    const explained = isConjugated
      ? explainJapaneseInflection(cleanWord, found.word)
      : undefined;
    return {
      ...found,
      sourceKind: 'dictionary',
      isSampleFallback: true,
      frequencyBand: found.frequencyBand || freqInfo.frequencyBand,
      priorityBadge: freqInfo.priorityBadge,
      conjugatedForm: isConjugated ? cleanWord : undefined,
      inflectedSurface: isConjugated ? cleanWord : undefined,
      grammarSuffix: explained?.grammarSuffix,
      grammarMeaning: explained?.grammarMeaning,
      grammarSteps: explained?.grammarSteps?.length ? explained.grammarSteps : undefined,
    };
  }

  return null;
}

/**
 * Searches across all installed imports of the active language.
 * Groups results by source: Words, Names, Kanji, Examples, with no duplicate entries.
 */
export async function lookupJmdict(
  surface: string,
  lemma?: string,
  reading?: string,
  languageCode = 'ja'
): Promise<{
  primaryEntry: DictionaryEntry | null;
  allEntries: DictionaryEntry[];
  groupedResults: {
    words: DictionaryEntry[];
    names: DictionaryEntry[];
    kanji: DictionaryEntry[];
    examples: DictionaryEntry[];
  };
  isSampleFallback: boolean;
}> {
  const cleanSurface = surface.trim();
  const cleanLemma = lemma?.trim();
  const cleanReading = reading?.trim();

  // Protect standalone 1–2 kana grammatical particles and copulas from false kanji homonyms
  // (e.g. never map standalone "な" to 菜 "vegetables").
  const protectedInfo = languageCode === 'ja' ? PROTECTED_JA_GRAMMAR_TOKENS[cleanSurface] : undefined;
  if (protectedInfo && (!cleanLemma || cleanLemma === cleanSurface)) {
    const sampleHit = JAPANESE_DICTIONARY_SAMPLE.find((e) => e.word === cleanSurface);
    const primary = buildProtectedGrammarEntry(protectedInfo, sampleHit);
    return {
      primaryEntry: primary,
      allEntries: [primary],
      groupedResults: {
        words: [primary],
        names: [],
        kanji: [],
        examples: [],
      },
      isSampleFallback: false,
    };
  }

  // Check if imported dictionary/data exists for this language
  const hasImported = await hasImportedDictionary(languageCode);

  if (!hasImported) {
    const sampleEntry = lookupSampleDictionary(cleanSurface, cleanLemma);
    const kanjiMatches: DictionaryEntry[] = [];
    if (cleanSurface.length === 1 && JAPANESE_KANJI_DATABASE[cleanSurface]) {
      const k = JAPANESE_KANJI_DATABASE[cleanSurface];
      kanjiMatches.push({
        id: `kanji-${cleanSurface}`,
        word: cleanSurface,
        readings: [...(k.readings.on || []), ...(k.readings.kun || [])],
        meanings: k.meanings,
        partsOfSpeech: ['Kanji'],
        level: k.jlptLevel,
        frequencyRank: k.frequencyRank,
        kanjiBreakdown: [k],
        sourceKind: 'kanji',
        isSampleFallback: true,
      });
    }

    const words = sampleEntry ? [sampleEntry] : [];
    return {
      primaryEntry: sampleEntry,
      allEntries: words,
      groupedResults: {
        words,
        names: [],
        kanji: kanjiMatches,
        examples: [],
      },
      isSampleFallback: true,
    };
  }

  // Map to store matched entries keyed by entry id
  const matchesMap = new Map<string, { item: JmdictEntryItem; matchTier: number }>();

  // 1. Exact surface search
  if (cleanSurface) {
    const surfaceMatches = await db.jmdictEntries.where('forms').equals(cleanSurface).toArray();
    for (const item of surfaceMatches) {
      if (!item.languageCode || item.languageCode === languageCode) {
        matchesMap.set(item.id, { item, matchTier: 1 });
      }
    }
  }

  // 2. Lemma search
  if (cleanLemma && cleanLemma !== cleanSurface) {
    const lemmaMatches = await db.jmdictEntries.where('forms').equals(cleanLemma).toArray();
    for (const item of lemmaMatches) {
      if ((!item.languageCode || item.languageCode === languageCode) && !matchesMap.has(item.id)) {
        matchesMap.set(item.id, { item, matchTier: 2 });
      }
    }
  }

  // 2b. Indexed packForms inflection-to-lemma search (O(1))
  if (cleanSurface) {
    try {
      const formRow = await db.packForms.get([languageCode, cleanSurface.toLowerCase()]);
      if (formRow && formRow.lemmas.length > 0) {
        const formLemmaMatches = await db.jmdictEntries
          .where('forms')
          .anyOf(formRow.lemmas)
          .toArray();
        for (const item of formLemmaMatches) {
          if ((!item.languageCode || item.languageCode === languageCode) && !matchesMap.has(item.id)) {
            matchesMap.set(item.id, { item, matchTier: 2 });
          }
        }
      }
    } catch {
      // Ignore if packForms not yet populated
    }
  }

  // 2c. Backward-chaining rule-based Japanese deinflection search
  if (matchesMap.size === 0 && cleanSurface) {
    const deinfCandidates = deinflectJapanese(cleanSurface)
      .filter((c) => c.reasons.length > 0)
      .map((c) => c.lemma);
    if (deinfCandidates.length > 0) {
      const deinfMatches = await db.jmdictEntries
        .where('forms')
        .anyOf(Array.from(new Set(deinfCandidates)))
        .toArray();
      for (const item of deinfMatches) {
        if ((!item.languageCode || item.languageCode === languageCode) && !matchesMap.has(item.id)) {
          matchesMap.set(item.id, { item, matchTier: 2 });
        }
      }
    }
  }

  // 3. Reading search
  if (cleanReading && cleanReading !== cleanSurface && cleanReading !== cleanLemma) {
    const readingMatches = await db.jmdictEntries.where('forms').equals(cleanReading).toArray();
    for (const item of readingMatches) {
      if ((!item.languageCode || item.languageCode === languageCode) && !matchesMap.has(item.id)) {
        matchesMap.set(item.id, { item, matchTier: 3 });
      }
    }
  }

  // Fallback to sample dictionary if no matches in IndexedDB
  if (matchesMap.size === 0) {
    const sampleEntry = lookupSampleDictionary(cleanSurface, cleanLemma);
    const words = sampleEntry ? [sampleEntry] : [];
    return {
      primaryEntry: sampleEntry,
      allEntries: words,
      groupedResults: {
        words,
        names: [],
        kanji: [],
        examples: [],
      },
      isSampleFallback: true,
    };
  }

  // Rank entries:
  // Sort by priorityScore descending
  const ranked = Array.from(matchesMap.values()).sort((a, b) => {
    const scoreDiff = b.item.priorityScore - a.item.priorityScore;
    if (a.matchTier === b.matchTier) {
      return scoreDiff;
    }
    if (Math.abs(scoreDiff) >= 2500) {
      return scoreDiff;
    }
    return a.matchTier - b.matchTier;
  });

  const allEntries: DictionaryEntry[] = [];
  const groupedResults = {
    words: [] as DictionaryEntry[],
    names: [] as DictionaryEntry[],
    kanji: [] as DictionaryEntry[],
    examples: [] as DictionaryEntry[],
  };

  const seenIds = new Set<string>();

  for (const { item } of ranked) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);

    const entry = mapJmdictItemToEntry(item, cleanSurface, cleanLemma);
    allEntries.push(entry);

    if (entry.sourceKind === 'names') {
      groupedResults.names.push(entry);
    } else if (entry.sourceKind === 'kanji') {
      groupedResults.kanji.push(entry);
    } else if (entry.sourceKind === 'sentences') {
      groupedResults.examples.push(entry);
    } else {
      groupedResults.words.push(entry);
    }
  }

  // If no kanji entry in DB for single character, try KANJIDIC sample
  if (cleanSurface.length === 1 && groupedResults.kanji.length === 0 && JAPANESE_KANJI_DATABASE[cleanSurface]) {
    const k = JAPANESE_KANJI_DATABASE[cleanSurface];
    groupedResults.kanji.push({
      id: `kanji-${cleanSurface}`,
      word: cleanSurface,
      readings: [...(k.readings.on || []), ...(k.readings.kun || [])],
      meanings: k.meanings,
      partsOfSpeech: ['Kanji'],
      level: k.jlptLevel,
      frequencyRank: k.frequencyRank,
      kanjiBreakdown: [k],
      sourceKind: 'kanji',
      isSampleFallback: true,
    });
  }

  // Primary entry: prefer highest-ranked word, fallback to highest-ranked name or other
  const primary = groupedResults.words[0] || groupedResults.names[0] || allEntries[0] || null;

  if (primary) {
    if (groupedResults.examples.length > 0) {
      const mergedExamples = [...(primary.examples || [])];
      const seenSentences = new Set(mergedExamples.map((e) => e.original));
      for (const exEntry of groupedResults.examples) {
        if (!exEntry.word || seenSentences.has(exEntry.word)) continue;
        seenSentences.add(exEntry.word);
        mergedExamples.push({
          original: exEntry.word,
          translation: exEntry.meanings?.[0] || '',
          reading: exEntry.readings?.[0] || undefined,
        });
      }
      primary.examples = mergedExamples;
    }
    primary.allEntries = allEntries;
    primary.groupedResults = groupedResults;
  }

  return {
    primaryEntry: primary,
    allEntries,
    groupedResults,
    isSampleFallback: false,
  };
}
