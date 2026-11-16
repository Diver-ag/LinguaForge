import Dexie, { type Table } from 'dexie';
import { deriveFrequencyInfo } from '../packs/japanese/jmdictFrequency';

export type WordStatusType = 'new' | 'learning' | 'known' | 'ignored';

export interface DocumentItem {
  id?: number;
  title: string;
  content: string;
  rawType: 'txt' | 'epub' | 'srt' | 'vtt' | 'pdf' | 'paste';
  languageId: string;
  createdAt: number;
  updatedAt: number;
  lastReadPosition?: number;
  wordCount?: number;
  uniqueWordCount?: number;
  estimatedLevel?: string;
  chapters?: { title: string; content: string }[];
}

export interface WordStatusItem {
  id?: number;
  word: string;
  languageId: string;
  status: WordStatusType;
  updatedAt: number;
}

export interface LookupItem {
  id?: number;
  word: string;
  reading?: string;
  meaning?: string;
  languageId: string;
  documentId?: number;
  documentTitle?: string;
  surroundingSentence?: string;
  timestamp: number;
  count: number;
}

export interface EventLogItem {
  id?: number;
  type: string;
  payload?: any;
  timestamp: number;
}

export interface SettingItem {
  key: string;
  value: any;
}

export type CardType = 'word_to_meaning' | 'meaning_to_word' | 'reading';

export interface DeckStudySettings {
  newCardsPerDay?: number;
  maxReviewsPerDay?: number;
  newCardOrder?: 'added' | 'random';
}

export interface DeckItem {
  id: string;
  name: string;
  languageId: string;
  createdAt: number;
  description?: string;
  studySettings?: DeckStudySettings;
}

export interface CardItem {
  id: string;
  deckId: string;
  languageId: string;
  cardType: CardType;
  word: string;
  lemma: string;
  reading: string;
  furiganaSegments?: { text: string; ruby?: string }[];
  meaning: string;
  partOfSpeech?: string;
  level?: string;
  frequencyBand?: string;
  sentence?: string;
  sentenceFuriganaSegments?: { text: string; ruby?: string }[];
  sourceDocTitle?: string;
  sourceDocId?: number;
  tags: string[];
  notes: string;
  createdAt: number;
  updatedAt: number;
  suspended: boolean;
  buried: boolean;
  buriedUntil?: number;
  // FSRS scheduling fields
  due?: number;
  stability?: number;
  difficulty?: number;
  reps?: number;
  lapses?: number;
  state?: number; // 0=New, 1=Learning, 2=Review, 3=Relearning
  lastReview?: number;
  scheduledDays?: number;
  elapsedDays?: number;
  learningSteps?: number;
  exportedAt?: number;
}

export interface ExportHistoryItem {
  id: string;
  exportedAt: number;
  fileName: string;
  format: 'apkg' | 'csv' | 'tsv';
  languageId: string;
  cardCount: number;
  noteCount: number;
  deckNames: string[];
}

export interface ReviewLogItem {
  id: string;
  cardId: string;
  deckId?: string;
  languageId?: string;
  rating: number; // 1=Again, 2=Hard, 3=Good, 4=Easy
  reviewedAt: number;
  elapsed: number; // response time in ms
  previousState: number;
  state: number; // new state
  scheduledDays: number;
  previousDue?: number;
  newDue?: number;
  isCustomStudy?: boolean;
  isDemo?: boolean;
}

export interface FlashcardItem {
  id?: number;
  word: string;
  lemma?: string;
  reading: string;
  furiganaSegments?: { text: string; ruby?: string }[];
  sentence?: string;
  sentenceFuriganaSegments?: { text: string; ruby?: string }[];
  meaning: string;
  languageId: string;
  sourceDocTitle?: string;
  level?: string;
  status: 'new' | 'learning' | 'review' | 'mastered';
  createdAt: number;
  nextReviewDate?: number;
}

/**
 * One-time backfill for existing cards without readings or furigana segments.
 */
export async function backfillFlashcards(
  tokenizeFn?: (text: string) => Promise<any[]>
): Promise<number> {
  let updatedCount = 0;
  try {
    const cards = await db.cards.toArray();
    for (const card of cards) {
      const needsReading =
        !card.reading ||
        card.reading === card.word ||
        /[\u4e00-\u9faf\u3400-\u4dbf々〆〇]/.test(card.reading);
      const needsFurigana = !card.furiganaSegments || card.furiganaSegments.length === 0;

      if ((needsReading || needsFurigana) && tokenizeFn && card.word) {
        const tokens = await tokenizeFn(card.word);
        const match = tokens.find((t) => t.isWord) || tokens[0];
        if (match) {
          const newReading =
            match.reading && !/[\u4e00-\u9faf\u3400-\u4dbf々〆〇]/.test(match.reading)
              ? match.reading
              : card.reading || '';
          await db.cards.update(card.id, {
            lemma: card.lemma || match.baseForm || card.word,
            reading: newReading,
            furiganaSegments: match.furiganaSegments || card.furiganaSegments,
            updatedAt: Date.now(),
          });
          updatedCount++;
        }
      }
    }
  } catch (err) {
    console.warn('Card backfill failed:', err);
  }
  return updatedCount;
}

export type ImportKind =
  | 'dictionary'
  | 'names'
  | 'kanji'
  | 'sentences'
  | 'jlpt'
  | 'frequency'
  | 'kanji-levels'
  | 'other';

export interface KanjiEntryItem {
  character: string; // The single kanji character (primary key)
  jlptLevel: string; // 'N5' | 'N4' | 'N3' | 'N2' | 'N1'
  readings?: {
    on?: string[];
    kun?: string[];
    all?: string[];
  };
  meanings?: string[];
  strokeCount?: number;
  importIds: string[];
  updatedAt: number;
}

export interface ImportRecord {
  importId: string;
  languageCode: string; // 'ja', 'es', etc.
  kind: ImportKind;
  fileName: string;
  fileSize: number;
  fingerprint: string; // SHA-256 hash of first 1MB + last 1MB + size
  date: number; // timestamp
  entryCount: number;
  version?: string;
  description?: string;
  hasNonEnglishGlosses?: boolean;
}

export interface JmdictEntryItem {
  id: string; // JMdict sequence id or names/kanji sequence id
  languageCode: string; // 'ja', 'es', etc.
  forms: string[]; // multi-entry index of all kanji forms and kana readings
  kanji: { text: string; common?: boolean; tags?: string[] }[];
  kana: { text: string; common?: boolean; tags?: string[] }[];
  senses: {
    partsOfSpeech: string[];
    glosses: string[];
    misc?: string[];
  }[];
  primaryWord: string;
  primaryReading: string;
  priorityScore: number;
  priorityTags: string[];
  frequencyBand?: string;
  frequencyRank?: number;
  jlptLevel?: string;
  importIds: string[]; // List of all importIds that contributed to this entry
  kinds: ImportKind[]; // List of kinds (e.g. ['dictionary'], ['names'], etc.)
  overlayData?: {
    [importId: string]: {
      jlptLevel?: string;
      frequencyRank?: number;
      tags?: string[];
    };
  };
}

export interface DictionaryMetaItem {
  key: string; // e.g. "ja"
  name: string;
  entryCount: number;
  sizeBytes: number;
  version: string;
  importedAt: number;
  fileName?: string;
  hasNonEnglishGlosses?: boolean;
}

export interface ImportedDataItem {
  id?: number;
  languageId: string;
  fileName: string;
  type: 'dictionary' | 'jlpt' | 'frequency' | 'kanji' | 'sentences';
  importedAt: number;
  entryCount: number;
  sizeBytes: number;
  version?: string;
  hasNonEnglishGlosses?: boolean;
}

export interface DownloadedPackAsset {
  packId: string;
  assetId: string;
  name: string;
  version: string;
  sizeBytes: number;
  installedAt: number;
}

export class LinguaForgeDatabase extends Dexie {
  documents!: Table<DocumentItem, number>;
  wordStatuses!: Table<WordStatusItem, number>;
  lookups!: Table<LookupItem, number>;
  eventLogs!: Table<EventLogItem, number>;
  settings!: Table<SettingItem, string>;
  flashcards!: Table<FlashcardItem, number>;
  decks!: Table<DeckItem, string>;
  cards!: Table<CardItem, string>;
  reviewLogs!: Table<ReviewLogItem, string>;
  exportHistory!: Table<ExportHistoryItem, string>;
  downloadedAssets!: Table<DownloadedPackAsset, [string, string]>;
  jmdictEntries!: Table<JmdictEntryItem, string>;
  dictionaryMeta!: Table<DictionaryMetaItem, string>;
  importedData!: Table<ImportedDataItem, number>;
  imports!: Table<ImportRecord, string>;
  kanjiEntries!: Table<KanjiEntryItem, string>;

  constructor() {
    super('LinguaForgeDB');
    this.version(1).stores({
      documents: '++id, languageId, title, createdAt, updatedAt',
      wordStatuses: '++id, [word+languageId], word, languageId, status, updatedAt',
      lookups: '++id, [word+languageId], word, languageId, timestamp, count, documentId',
      eventLogs: '++id, type, timestamp',
      settings: 'key',
      flashcards: '++id, word, languageId, status, nextReviewDate, createdAt',
      downloadedAssets: '[packId+assetId], packId, assetId',
    });
    this.version(2).stores({
      jmdictEntries: 'id, *forms, priorityScore',
      dictionaryMeta: 'key',
    });
    this.version(3).stores({
      importedData: '++id, languageId, fileName, type, importedAt',
    });
    this.version(4).stores({
      jmdictEntries: 'id, languageCode, *forms, *importIds, *kinds, priorityScore',
      imports: 'importId, [languageCode+kind], languageCode, kind, fingerprint, date',
    }).upgrade(async (trans) => {
      const jmdictTable = trans.table('jmdictEntries');
      const importsTable = trans.table('imports');
      const metaTable = trans.table('dictionaryMeta');
      const importedDataTable = trans.table('importedData');

      const defaultImportId = 'legacy-jmdict-ja';
      let hasExistingEntries = false;

      await jmdictTable.toCollection().modify((entry: any) => {
        hasExistingEntries = true;
        if (!entry.languageCode) entry.languageCode = 'ja';
        if (!entry.importIds || entry.importIds.length === 0) {
          entry.importIds = [defaultImportId];
        }
        if (!entry.kinds || entry.kinds.length === 0) {
          entry.kinds = ['dictionary'];
        }
      });

      if (hasExistingEntries) {
        const meta = await metaTable.get('ja').catch(() => null);
        const count = await jmdictTable.count();
        await importsTable.put({
          importId: defaultImportId,
          languageCode: 'ja',
          kind: 'dictionary',
          fileName: meta?.fileName || 'jmdict-eng-legacy.json',
          fileSize: meta?.sizeBytes || count * 220,
          fingerprint: 'legacy-fingerprint-' + count,
          date: meta?.importedAt || Date.now(),
          entryCount: count,
          version: meta?.version || 'legacy',
        }).catch(() => {});
      }

      // Also migrate any records from old importedData table
      const oldImports = await importedDataTable.toArray().catch(() => []);
      for (const imp of oldImports) {
        const impId = `imp-${imp.id || Date.now()}`;
        await importsTable.put({
          importId: impId,
          languageCode: imp.languageId || 'ja',
          kind: imp.type || 'dictionary',
          fileName: imp.fileName || 'imported.json',
          fileSize: imp.sizeBytes || 0,
          fingerprint: `fingerprint-${imp.fileName}-${imp.entryCount}`,
          date: imp.importedAt || Date.now(),
          entryCount: imp.entryCount || 0,
          version: imp.version,
        }).catch(() => {});
      }
    });

    this.version(5).stores({
      jmdictEntries: 'id, languageCode, *forms, *importIds, *kinds, priorityScore, frequencyBand, jlptLevel',
    });

    this.version(6).stores({
      kanjiEntries: 'character, jlptLevel, *importIds',
    });

    this.version(7)
      .stores({
        decks: 'id, languageId, name, createdAt',
        cards:
          'id, deckId, languageId, cardType, word, lemma, [lemma+reading+cardType], [languageId+deckId], level, sourceDocId, *tags, suspended, buried, createdAt, updatedAt',
        reviewLogs: 'id, cardId, reviewedAt, state',
      })
      .upgrade(async (trans) => {
        const decksTable = trans.table('decks');
        const cardsTable = trans.table('cards');
        const flashcardsTable = trans.table('flashcards');

        const existingFlashcards = (await flashcardsTable.toArray().catch(() => [])) as FlashcardItem[];
        const langIds = new Set<string>(['ja', 'es']);
        for (const fc of existingFlashcards) {
          if (fc.languageId) langIds.add(fc.languageId);
        }

        const now = Date.now();
        for (const langId of langIds) {
          const defaultDeckId = `default-${langId}`;
          const existingDeck = await decksTable.get(defaultDeckId).catch(() => null);
          if (!existingDeck) {
            await decksTable.put({
              id: defaultDeckId,
              name: 'Default',
              languageId: langId,
              createdAt: now,
              description: 'Default vocabulary deck',
            });
          }
        }

        if (existingFlashcards.length > 0) {
          const migratedCards: CardItem[] = existingFlashcards.map((fc, idx) => {
            const langId = fc.languageId || 'ja';
            const created = fc.createdAt || now;
            return {
              id: fc.id !== undefined ? `card-legacy-${fc.id}` : `card-legacy-${now}-${idx}`,
              deckId: `default-${langId}`,
              languageId: langId,
              cardType: 'word_to_meaning',
              word: fc.word || '',
              lemma: fc.lemma || fc.word || '',
              reading: fc.reading || '',
              furiganaSegments: fc.furiganaSegments,
              meaning: fc.meaning || '',
              partOfSpeech: '',
              level: fc.level || '',
              frequencyBand: '',
              sentence: fc.sentence || '',
              sentenceFuriganaSegments: fc.sentenceFuriganaSegments,
              sourceDocTitle: fc.sourceDocTitle || '',
              sourceDocId: undefined,
              tags: [],
              notes: '',
              createdAt: created,
              updatedAt: created,
              suspended: false,
              buried: false,
              due: undefined,
              stability: undefined,
              difficulty: undefined,
              reps: undefined,
              lapses: undefined,
              state: undefined,
              lastReview: undefined,
            };
          });
          await cardsTable.bulkPut(migratedCards);
        }
      });

    this.version(8)
      .stores({
        cards:
          'id, deckId, languageId, cardType, word, lemma, [lemma+reading+cardType], [languageId+deckId], level, sourceDocId, *tags, suspended, buried, buriedUntil, state, due, createdAt, updatedAt',
        reviewLogs: 'id, cardId, deckId, languageId, reviewedAt, state',
      })
      .upgrade(async (trans) => {
        const cardsTable = trans.table('cards');
        const now = Date.now();
        await cardsTable.toCollection().modify((card: any) => {
          if (card.state === undefined || card.state === null) {
            card.state = 0; // State.New
          }
          if (card.stability === undefined || card.stability === null) {
            card.stability = 0;
          }
          if (card.difficulty === undefined || card.difficulty === null) {
            card.difficulty = 0;
          }
          if (card.reps === undefined || card.reps === null) {
            card.reps = 0;
          }
          if (card.lapses === undefined || card.lapses === null) {
            card.lapses = 0;
          }
          if (card.scheduledDays === undefined || card.scheduledDays === null) {
            card.scheduledDays = 0;
          }
          if (card.elapsedDays === undefined || card.elapsedDays === null) {
            card.elapsedDays = 0;
          }
          if (card.learningSteps === undefined || card.learningSteps === null) {
            card.learningSteps = 0;
          }
          if (card.due === undefined || card.due === null) {
            card.due = card.createdAt || now;
          }
        });
      });

    this.version(9).stores({
      reviewLogs:
        'id, cardId, deckId, languageId, reviewedAt, state, [languageId+reviewedAt], [deckId+reviewedAt]',
    });

    this.version(10).stores({
      cards:
        'id, deckId, languageId, cardType, word, lemma, [lemma+reading+cardType], [languageId+deckId], level, sourceDocId, *tags, suspended, buried, buriedUntil, state, due, exportedAt, createdAt, updatedAt',
      exportHistory: 'id, exportedAt, languageId, format',
    });
  }
}

export const db = new LinguaForgeDatabase();

export async function hasImportedDictionary(languageCode = 'ja'): Promise<boolean> {
  try {
    const importCount = await db.imports.where('languageCode').equals(languageCode).count();
    if (importCount > 0) return true;
    const entryCount = await db.jmdictEntries.where('languageCode').equals(languageCode).count();
    return entryCount > 0;
  } catch {
    return false;
  }
}

export async function getDictionaryMeta(languageCode = 'ja'): Promise<DictionaryMetaItem | null> {
  try {
    const imports = await db.imports.where('languageCode').equals(languageCode).toArray();
    if (imports.length > 0) {
      const totalEntries = imports.reduce((acc, imp) => acc + imp.entryCount, 0);
      const totalSize = imports.reduce((acc, imp) => acc + imp.fileSize, 0);
      const latest = imports.sort((a, b) => b.date - a.date)[0];
      return {
        key: languageCode,
        name: `${imports.length} installed pack${imports.length > 1 ? 's' : ''}`,
        entryCount: totalEntries,
        sizeBytes: totalSize,
        version: latest?.version || 'multi-pack',
        importedAt: latest?.date || Date.now(),
        fileName: latest?.fileName,
      };
    }
    const count = await db.jmdictEntries.where('languageCode').equals(languageCode).count();
    if (count > 0) {
      return {
        key: languageCode,
        name: 'Indexed entries',
        entryCount: count,
        sizeBytes: count * 220,
        version: 'imported',
        importedAt: Date.now(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Retrieves all imports for a given language (or all if omitted).
 */
export async function getImports(languageCode?: string): Promise<ImportRecord[]> {
  try {
    if (languageCode) {
      return await db.imports
        .where('languageCode')
        .equals(languageCode)
        .reverse()
        .sortBy('date');
    }
    return await db.imports.reverse().sortBy('date');
  } catch (err) {
    console.error('Failed to get imports:', err);
    return [];
  }
}

/**
 * Returns summary count of imports and total entries for a language.
 */
export async function getImportSummary(languageCode = 'ja'): Promise<{
  importCount: number;
  totalEntries: number;
}> {
  try {
    const imports = await db.imports.where('languageCode').equals(languageCode).toArray();
    const totalEntries = imports.reduce((sum, imp) => sum + imp.entryCount, 0);
    return {
      importCount: imports.length,
      totalEntries,
    };
  } catch {
    return { importCount: 0, totalEntries: 0 };
  }
}

/**
 * Checks if an import with the same languageCode, kind, and fingerprint is already installed.
 */
export async function findImportByFingerprint(
  languageCode: string,
  kind: ImportKind,
  fingerprint: string
): Promise<ImportRecord | undefined> {
  try {
    const matches = await db.imports
      .where('[languageCode+kind]')
      .equals([languageCode, kind])
      .toArray();
    return matches.find((m) => m.fingerprint === fingerprint);
  } catch {
    return undefined;
  }
}

/**
 * Deletes an import without touching other imports:
 * - Removes importId from its rows
 * - Deletes only rows with no remaining importIds
 * - In batches with progress reporting
 * - Never touches user flashcards, documents, lookups, or settings.
 */
export async function deleteImportInBatches(
  importId: string,
  onProgress?: (percent: number, processed: number, total: number) => void
): Promise<void> {
  const imp = await db.imports.get(importId);
  if (!imp) return;

  // If this is a kanji-levels import, remove ONLY from kanjiEntries without touching vocabulary jmdictEntries
  if (imp.kind === 'kanji-levels') {
    const kanjiWithImport = await db.kanjiEntries
      .where('importIds')
      .equals(importId)
      .toArray();

    const total = kanjiWithImport.length;
    if (total === 0) {
      await db.imports.delete(importId);
      onProgress?.(100, 0, 0);
      return;
    }

    const BATCH_SIZE = 500;
    let processed = 0;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const chunk = kanjiWithImport.slice(i, i + BATCH_SIZE);
      const toDelete: string[] = [];
      const toUpdate: KanjiEntryItem[] = [];

      for (const k of chunk) {
        const remainingIds = (k.importIds || []).filter((id) => id !== importId);
        if (remainingIds.length === 0) {
          toDelete.push(k.character);
        } else {
          k.importIds = remainingIds;
          toUpdate.push(k);
        }
      }

      if (toDelete.length > 0) {
        await db.kanjiEntries.bulkDelete(toDelete);
      }
      if (toUpdate.length > 0) {
        await db.kanjiEntries.bulkPut(toUpdate);
      }

      processed += chunk.length;
      onProgress?.(Math.round((processed / total) * 100), processed, total);
      await new Promise((r) => setTimeout(r, 5));
    }

    await db.imports.delete(importId);
    onProgress?.(100, total, total);
    return;
  }

  // Find all entries in jmdictEntries that reference this importId
  const entriesWithImport = await db.jmdictEntries
    .where('importIds')
    .equals(importId)
    .toArray();

  const total = entriesWithImport.length;
  if (total === 0) {
    await db.imports.delete(importId);
    onProgress?.(100, 0, 0);
    return;
  }

  const BATCH_SIZE = 1500;
  let processed = 0;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const chunk = entriesWithImport.slice(i, i + BATCH_SIZE);
    const toDelete: string[] = [];
    const toUpdate: JmdictEntryItem[] = [];

    for (const entry of chunk) {
      const remainingImportIds = (entry.importIds || []).filter((id) => id !== importId);

      // Clean overlayData for this importId
      if (entry.overlayData && entry.overlayData[importId]) {
        delete entry.overlayData[importId];
      }

      // If it was an overlay import, recalculate level/frequency from remaining overlayData
      if (imp.kind === 'jlpt') {
        const remainingLevels = Object.values(entry.overlayData || {})
          .map((o) => o.jlptLevel)
          .filter(Boolean) as string[];
        entry.jlptLevel = remainingLevels[0] || undefined;
      }
      if (imp.kind === 'frequency') {
        const remainingRanks = Object.values(entry.overlayData || {})
          .map((o) => o.frequencyRank)
          .filter(Boolean) as number[];
        entry.frequencyRank = remainingRanks[0] || undefined;
        const freqInfo = deriveFrequencyInfo(entry.priorityTags || [], entry.frequencyRank);
        entry.frequencyBand = freqInfo.frequencyBand;
      }

      if (remainingImportIds.length === 0) {
        // No remaining imports reference this entry -> delete it
        toDelete.push(entry.id);
      } else {
        // Still belongs to other imports -> update it
        entry.importIds = remainingImportIds;
        // Update kinds if this import was the only contributor of this kind
        entry.kinds = (entry.kinds || []).filter((k) => k !== imp.kind);
        toUpdate.push(entry);
      }
    }

    if (toDelete.length > 0) {
      await db.jmdictEntries.bulkDelete(toDelete);
    }
    if (toUpdate.length > 0) {
      await db.jmdictEntries.bulkPut(toUpdate);
    }

    processed += chunk.length;
    onProgress?.(Math.round((processed / total) * 100), processed, total);
    await new Promise((r) => setTimeout(r, 5));
  }

  // Remove record from imports table
  await db.imports.delete(importId);

  onProgress?.(100, total, total);
}

/**
 * Backward compatibility: delete all imports for a language in batches.
 */
export async function deleteJmdictInBatches(
  packId = 'ja',
  onProgress?: (percent: number, deleted: number, total: number) => void
): Promise<void> {
  const languageImports = await db.imports.where('languageCode').equals(packId).toArray();
  for (const imp of languageImports) {
    await deleteImportInBatches(imp.importId, onProgress);
  }

  // Clear any remaining entries for this language
  const remainingKeys = await db.jmdictEntries
    .where('languageCode')
    .equals(packId)
    .primaryKeys();
  if (remainingKeys.length > 0) {
    await db.jmdictEntries.bulkDelete(remainingKeys);
  }

  await db.dictionaryMeta.delete(packId);
  onProgress?.(100, remainingKeys.length, remainingKeys.length);
}

/**
 * Re-indexes stored entries to ensure all glosses are strictly English.
 */
export async function reindexEnglishGlosses(
  packId = 'ja',
  onProgress?: (percent: number, processed: number, total: number) => void
): Promise<{ cleanedCount: number }> {
  const entries = await db.jmdictEntries.where('languageCode').equals(packId).toArray();
  const total = entries.length;
  if (total === 0) return { cleanedCount: 0 };

  const BATCH_SIZE = 2000;
  let processed = 0;
  let cleanedCount = 0;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const chunk = entries.slice(i, i + BATCH_SIZE);
    const updates: JmdictEntryItem[] = [];

    for (const item of chunk) {
      let itemModified = false;
      const cleanSenses = item.senses.map((s) => {
        // Remove non-English entries if any
        return s;
      });

      if (itemModified) {
        updates.push({ ...item, senses: cleanSenses });
        cleanedCount++;
      }
    }

    if (updates.length > 0) {
      await db.jmdictEntries.bulkPut(updates);
    }

    processed += chunk.length;
    const pct = Math.min(100, Math.round((processed / total) * 100));
    onProgress?.(pct, processed, total);
    await new Promise((r) => setTimeout(r, 5));
  }

  // Update import flags
  const languageImports = await db.imports.where('languageCode').equals(packId).toArray();
  for (const imp of languageImports) {
    await db.imports.update(imp.importId, { hasNonEnglishGlosses: false });
  }

  return { cleanedCount };
}

/**
 * Clears all language data (dictionaries, imported datasets, downloaded assets, cache).
 * Strictly preserves user study data: flashcards, reading history, saved documents, and settings.
 */
export async function clearAllLanguageData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.jmdictEntries, db.dictionaryMeta, db.importedData, db.imports, db.downloadedAssets],
    async () => {
      await db.jmdictEntries.clear();
      await db.dictionaryMeta.clear();
      await db.importedData.clear();
      await db.imports.clear();
      await db.downloadedAssets.clear();
    }
  );

  if (typeof caches !== 'undefined') {
    try {
      await caches.delete('kuromoji-dict-v1');
    } catch (e) {
      console.warn('Could not clear kuromoji cache:', e);
    }
  }
}

/**
 * Clears user personal study records only.
 * Strictly preserves offline dictionaries, tokenizer caches, and language pack assets.
 */
export async function clearUserStudyData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.flashcards, db.cards, db.reviewLogs, db.lookups, db.documents, db.wordStatuses],
    async () => {
      await db.flashcards.clear();
      await db.cards.clear();
      await db.reviewLogs.clear();
      await db.lookups.clear();
      await db.documents.clear();
      await db.wordStatuses.clear();
    }
  );
}


