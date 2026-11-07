import { db, type KanjiEntryItem } from '../../db/db';
import { JAPANESE_KANJI_DATABASE } from './kanjiData';
import type { KanjiDetail } from '../../core/languagePack';

export const CJK_KANJI_REGEX = /[\u4e00-\u9faf\u3400-\u4dbf々〆〇]/g;

/**
 * Extracts unique kanji characters from any Japanese text string.
 */
export function extractKanjiCharacters(text: string): string[] {
  if (!text) return [];
  const matches = text.match(CJK_KANJI_REGEX) || [];
  return Array.from(new Set(matches));
}

/**
 * Compares two JLPT levels to determine which is "easier" (beginner-first).
 * JLPT hierarchy: N5 is Level 5 (easiest / beginner) ... N1 is Level 1 (hardest / advanced).
 * So N5 is easier than N4, N4 is easier than N3, etc.
 */
export function isEasierLevel(candidateLevel: string, existingLevel: string): boolean {
  const cNum = parseInt(candidateLevel.replace(/\D/g, ''), 10);
  const eNum = parseInt(existingLevel.replace(/\D/g, ''), 10);
  if (!eNum || isNaN(eNum)) return true;
  if (!cNum || isNaN(cNum)) return false;
  // N5 (5) > N4 (4) -> higher number is easier
  return cNum > eNum;
}

/**
 * Difficulty rank: N1 is highest difficulty (5), N5 is lowest difficulty (1).
 */
const DIFFICULTY_ORDER: Record<string, number> = {
  N1: 5,
  N2: 4,
  N3: 3,
  N4: 2,
  N5: 1,
};

/**
 * Calculates the "hardest" kanji level present in a word (e.g. N5 and N3 -> N3).
 * Returns null if no kanji has a valid level.
 */
export function getHardestKanjiLevel(
  kanjiList: { character: string; jlptLevel?: string }[]
): string | null {
  let highestRank = 0;
  let hardestLevel: string | null = null;

  for (const k of kanjiList) {
    if (!k.jlptLevel) continue;
    const clean = k.jlptLevel.toUpperCase().trim();
    const rank = DIFFICULTY_ORDER[clean];
    if (rank && rank > highestRank) {
      highestRank = rank;
      hardestLevel = clean;
    }
  }

  return hardestLevel;
}

/**
 * Retrieves full details for kanji in a word, combining imported kanji data with
 * built-in sample KANJIDIC data. Fully functional even if KANJIDIC is not installed.
 */
export async function getKanjiDetailsForWord(word: string): Promise<KanjiDetail[]> {
  const chars = extractKanjiCharacters(word);
  if (chars.length === 0) return [];

  const result: KanjiDetail[] = [];

  try {
    // Look up in Dexie kanjiEntries table
    const dbEntries = await db.kanjiEntries.where('character').anyOf(chars).toArray();
    const dbMap = new Map<string, KanjiEntryItem>();
    for (const entry of dbEntries) {
      dbMap.set(entry.character, entry);
    }

    for (const char of chars) {
      const dbEntry = dbMap.get(char);
      const sampleEntry = JAPANESE_KANJI_DATABASE[char];

      const jlptLevel = dbEntry?.jlptLevel || sampleEntry?.jlptLevel || undefined;
      const meanings = (dbEntry?.meanings && dbEntry.meanings.length > 0)
        ? dbEntry.meanings
        : (sampleEntry?.meanings && sampleEntry.meanings.length > 0)
        ? sampleEntry.meanings
        : ['Kanji character'];

      const onReadings = dbEntry?.readings?.on || sampleEntry?.readings?.on || [];
      const kunReadings = dbEntry?.readings?.kun || sampleEntry?.readings?.kun || [];
      const strokeCount = dbEntry?.strokeCount || sampleEntry?.strokeCount;
      const radicals = sampleEntry?.radicals || [];
      const frequencyRank = sampleEntry?.frequencyRank;

      result.push({
        character: char,
        jlptLevel,
        meanings,
        readings: {
          on: onReadings,
          kun: kunReadings,
        },
        strokeCount,
        radicals,
        frequencyRank,
      });
    }
  } catch (err) {
    console.warn('Failed to query kanjiEntries from db, falling back to sample:', err);
    for (const char of chars) {
      const sample = JAPANESE_KANJI_DATABASE[char];
      if (sample) {
        result.push(sample);
      } else {
        result.push({
          character: char,
          meanings: ['Kanji character'],
          readings: {},
          radicals: [],
        });
      }
    }
  }

  return result;
}

/**
 * Computes the "Kanji by level" breakdown for a list of tokens or raw text.
 */
export async function getKanjiStatsForText(text: string): Promise<{
  totalUnique: number;
  counts: Record<'N5' | 'N4' | 'N3' | 'N2' | 'N1' | 'unlisted', number>;
  kanjiByLevel: Record<'N5' | 'N4' | 'N3' | 'N2' | 'N1' | 'unlisted', string[]>;
  unlisted: string[];
}> {
  const uniqueChars = extractKanjiCharacters(text);
  const counts: Record<'N5' | 'N4' | 'N3' | 'N2' | 'N1' | 'unlisted', number> = {
    N5: 0,
    N4: 0,
    N3: 0,
    N2: 0,
    N1: 0,
    unlisted: 0,
  };
  const kanjiByLevel: Record<'N5' | 'N4' | 'N3' | 'N2' | 'N1' | 'unlisted', string[]> = {
    N5: 0 as any,
    N4: 0 as any,
    N3: 0 as any,
    N2: 0 as any,
    N1: 0 as any,
    unlisted: 0 as any,
  };
  kanjiByLevel.N5 = [];
  kanjiByLevel.N4 = [];
  kanjiByLevel.N3 = [];
  kanjiByLevel.N2 = [];
  kanjiByLevel.N1 = [];
  kanjiByLevel.unlisted = [];

  if (uniqueChars.length === 0) {
    return {
      totalUnique: 0,
      counts,
      kanjiByLevel,
      unlisted: [],
    };
  }

  try {
    const dbEntries = await db.kanjiEntries.where('character').anyOf(uniqueChars).toArray();
    const dbMap = new Map<string, KanjiEntryItem>();
    for (const e of dbEntries) {
      dbMap.set(e.character, e);
    }

    for (const char of uniqueChars) {
      const dbEntry = dbMap.get(char);
      const sample = JAPANESE_KANJI_DATABASE[char];
      const level = dbEntry?.jlptLevel || sample?.jlptLevel;

      if (level && /^N[1-5]$/i.test(level)) {
        const lvl = level.toUpperCase() as 'N5' | 'N4' | 'N3' | 'N2' | 'N1';
        counts[lvl]++;
        kanjiByLevel[lvl].push(char);
      } else {
        counts.unlisted++;
        kanjiByLevel.unlisted.push(char);
      }
    }
  } catch (err) {
    console.warn('Error fetching kanji stats:', err);
    for (const char of uniqueChars) {
      const sample = JAPANESE_KANJI_DATABASE[char];
      if (sample?.jlptLevel && /^N[1-5]$/i.test(sample.jlptLevel)) {
        const lvl = sample.jlptLevel.toUpperCase() as 'N5' | 'N4' | 'N3' | 'N2' | 'N1';
        counts[lvl]++;
        kanjiByLevel[lvl].push(char);
      } else {
        counts.unlisted++;
        kanjiByLevel.unlisted.push(char);
      }
    }
  }

  return {
    totalUnique: uniqueChars.length,
    counts,
    kanjiByLevel,
    unlisted: kanjiByLevel.unlisted,
  };
}
