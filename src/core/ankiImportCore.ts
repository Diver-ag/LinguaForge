import JSZip from 'jszip';
import { decompress as fzstdDecompress } from 'fzstd';
import type { SqlJsStatic } from 'sql.js';
import { db, type CardItem, type CardType, type DeckItem } from '../db/db';
import { ensureDefaultDeck, generateEntityId } from '../db/cards';
import type { FuriganaSegment } from './languagePack';
import { buildFurigana } from '../packs/japanese/kanaUtils';
import { parseInlineFurigana, parseTagsCell, type DuplicateImportMode } from './cardCsvImport';
import { invalidateStatsCache } from './statsCache';
import { logEvent } from './eventLogger';

export type ApkgCardField =
  | 'ignore'
  | 'word'
  | 'reading'
  | 'meaning'
  | 'sentence'
  | 'notes'
  | 'tags';

export const APKG_CARD_FIELD_OPTIONS: {
  value: ApkgCardField;
  label: string;
}[] = [
  { value: 'ignore', label: 'Skip / Ignore' },
  { value: 'word', label: 'Word (required)' },
  { value: 'reading', label: 'Reading' },
  { value: 'meaning', label: 'Meaning' },
  { value: 'sentence', label: 'Sentence' },
  { value: 'notes', label: 'Notes' },
  { value: 'tags', label: 'Tags' },
];

export type ApkgDbSourceKind = 'collection.anki21b' | 'collection.anki21' | 'collection.anki2';

export interface ApkgDeckInfo {
  id: string;
  name: string;
  noteCount: number;
}

export interface ApkgNoteTypeInfo {
  id: string;
  name: string;
  fieldNames: string[];
  noteCount: number;
  sampleFields: string[];
  defaultMapping: ApkgCardField[];
}

export interface ApkgInspectSummary {
  dbSource: ApkgDbSourceKind;
  totalNotes: number;
  skippedMediaCount: number;
  decks: ApkgDeckInfo[];
  noteTypes: ApkgNoteTypeInfo[];
  sampleNote?: {
    noteTypeName: string;
    deckName: string;
    tags: string[];
    fields: { name: string; raw: string; safeHtml: string; plainText: string }[];
  };
}

export interface RawApkgNoteRecord {
  noteId: number;
  modelId: string;
  deckId: string;
  deckName: string;
  tags: string;
  fields: string[];
}

export interface ApkgImportOptions {
  languageId: string;
  /** Map of Anki modelId -> array of ApkgCardField aligned with that model's fieldNames */
  modelMappings: Record<string, ApkgCardField[]>;
  deckMode: 'keep' | 'target';
  targetDeckId?: string;
  newDeckName?: string;
  cardType: CardType;
  duplicateMode: DuplicateImportMode;
  importAsNewOnly: boolean;
}

export interface ApkgFailedNote {
  noteId: number;
  modelName: string;
  word: string;
  reason: string;
  rawFields: string[];
}

export interface ApkgImportResult {
  notesRead: number;
  cardsCreated: number;
  cardsUpdated: number;
  skippedDuplicates: number;
  skippedMediaCount: number;
  createdDeckNames: string[];
  failedNotes: ApkgFailedNote[];
  cancelled: boolean;
}

export const ANKI_DUMMY_UPDATE_MESSAGE = 'Please update to the latest Anki version';
export const ANKI_REEXPORT_HELP_MESSAGE =
  "This package needs to be exported again from Anki with 'Support older Anki versions' ticked.";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export function isZstdCompressed(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === ZSTD_MAGIC[0] &&
    bytes[1] === ZSTD_MAGIC[1] &&
    bytes[2] === ZSTD_MAGIC[2] &&
    bytes[3] === ZSTD_MAGIC[3]
  );
}

/**
 * Safely sanitizes Anki HTML:
 * - Removes <script>, <style>, <iframe>, <object>, <embed> blocks completely
 * - Removes [sound:...] media tags
 * - Strips inline on* attributes and javascript: URLs
 * - Preserves only <ruby>, <rt>, <rp>, <b>, <strong>, <br>
 */
export function sanitizeAnkiHtml(rawHtml: string): string {
  if (!rawHtml) return '';

  let s = rawHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<(iframe|object|embed|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/\[sound:[^\]]+\]/gi, '');

  // Normalize <div> / <p> line breaks before stripping non-whitelisted tags
  s = s
    .replace(/<br\s*\/?>/gi, '<br>')
    .replace(/<\/(div|p|li|tr)>/gi, '<br>')
    .replace(/<(div|p|li|tr)\b[^>]*>/gi, '');

  // Keep only <ruby>, </ruby>, <rt>, </rt>, <rp>, </rp>, <b>, </b>, <strong>, </strong>, <br>
  s = s.replace(/<\/?([a-zA-Z0-9-]+)\b[^>]*>/g, (fullMatch, tagName: string) => {
    const lower = tagName.toLowerCase();
    const isClosing = fullMatch.startsWith('</');
    if (lower === 'br') {
      return isClosing ? '' : '<br>';
    }
    if (lower === 'ruby' || lower === 'rt' || lower === 'rp' || lower === 'b' || lower === 'strong') {
      return isClosing ? `</${lower}>` : `<${lower}>`;
    }
    return '';
  });

  // Collapse excessive leading/trailing <br>
  s = s.replace(/^(<br>\s*)+|(<br>\s*)+$/gi, '').trim();
  return s;
}

/**
 * Converts Anki HTML (after safe sanitization) into clean plain text suitable
 * for React text fields (meaning, notes, plain sentence, etc.).
 */
export function ankiHtmlToPlainText(rawHtml: string): string {
  if (!rawHtml) return '';
  const safe = sanitizeAnkiHtml(rawHtml);
  const withNewlines = safe
    .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '')
    .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '');

  return decodeBasicHtmlEntities(withNewlines)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeBasicHtmlEntities(str: string): string {
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

/**
 * Converts an Anki field that may contain `<ruby>漢字<rt>かんじ</rt></ruby>` or
 * `漢字[かんじ]` bracket syntax into plain text, reading, and `FuriganaSegment[]`.
 */
export function parseAnkiFuriganaField(rawHtml: string): {
  plainText: string;
  reading?: string;
  segments?: FuriganaSegment[];
} {
  if (!rawHtml) return { plainText: '' };

  // Strip scripts, styles, and sound tags; normalize <br> to spaces for word/sentence inline parsing
  const cleaned = sanitizeAnkiHtml(rawHtml)
    .replace(/<\/?(b|strong)>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ');

  const decoded = decodeBasicHtmlEntities(cleaned).trim();
  return parseInlineFurigana(decoded);
}

// ---------------------------------------------------------------------------
// Auto-Detect Anki Note-Type Field Mapping
// ---------------------------------------------------------------------------

const ANKI_FIELD_MATCHERS: {
  field: ApkgCardField;
  exact: string[];
  partial: string[];
}[] = [
  {
    field: 'word',
    exact: [
      'word',
      'expression',
      'vocab-kanji',
      'vocabkanji',
      'kanji',
      'vocab',
      'vocabulary',
      'term',
      'front',
      'japanese',
      'lemma',
      'target',
    ],
    partial: ['expression', 'vocab-kanji', 'vocabkanji', 'word', 'kanji', 'vocab', 'term'],
  },
  {
    field: 'reading',
    exact: [
      'reading',
      'readings',
      'kana',
      'vocab-kana',
      'vocabkana',
      'hiragana',
      'katakana',
      'yomi',
      'pronunciation',
      'furigana',
      'expression-reading',
      'word-reading',
    ],
    partial: ['reading', 'kana', 'yomi', 'pronun', 'furigana'],
  },
  {
    field: 'meaning',
    exact: [
      'meaning',
      'meanings',
      'definition',
      'definitions',
      'gloss',
      'english',
      'translation',
      'vocab-meaning',
      'vocabmeaning',
      'back',
      'meaning-en',
    ],
    partial: ['meaning', 'definit', 'gloss', 'translat', 'english'],
  },
  {
    field: 'sentence',
    exact: [
      'sentence',
      'example',
      'context',
      'sentence-jp',
      'sentencejp',
      'vocab-sentence',
      'example_sentence',
      'examplesentence',
      'sentencefuriganahtml',
    ],
    partial: ['sentence', 'example', 'context'],
  },
  {
    field: 'notes',
    exact: [
      'notes',
      'note',
      'memo',
      'comment',
      'comments',
      'hint',
      'explanation',
      'sentencemeaning',
      'sentence-meaning',
      'sentence-en',
    ],
    partial: ['note', 'memo', 'comment', 'explanation'],
  },
  {
    field: 'tags',
    exact: ['tags', 'tag', 'jlpt', 'level'],
    partial: ['tag'],
  },
];

export function detectDefaultApkgFieldMapping(fieldNames: string[]): ApkgCardField[] {
  const mapping: ApkgCardField[] = fieldNames.map(() => 'ignore');
  const used = new Set<ApkgCardField>();

  // Skip auxiliary HTML/Anki duplicate fields in first pass if primary fields exist
  const normalized = fieldNames.map((n) => n.trim().toLowerCase());
  const compactList = normalized.map((n) => n.replace(/[\s_-]+/g, ''));

  // Exact match pass
  for (let i = 0; i < fieldNames.length; i++) {
    const raw = normalized[i];
    const compact = compactList[i];
    if (!compact) continue;
    if (compact === 'furiganahtml' || compact === 'furiganaanki' || compact === 'sentencefuriganahtml') {
      continue;
    }

    for (const m of ANKI_FIELD_MATCHERS) {
      if (used.has(m.field)) continue;
      if (m.exact.includes(raw) || m.exact.some((e) => e.replace(/[\s_-]+/g, '') === compact)) {
        mapping[i] = m.field;
        used.add(m.field);
        break;
      }
    }
  }

  // Partial match pass
  for (let i = 0; i < fieldNames.length; i++) {
    if (mapping[i] !== 'ignore') continue;
    const compact = compactList[i];
    if (!compact || compact === 'furiganahtml' || compact === 'furiganaanki') continue;

    for (const m of ANKI_FIELD_MATCHERS) {
      if (used.has(m.field)) continue;
      if (m.partial.some((p) => compact.includes(p.replace(/[\s_-]+/g, '')))) {
        mapping[i] = m.field;
        used.add(m.field);
        break;
      }
    }
  }

  // Fallback: if still no `word` mapped, map field 0 -> word and field 1 -> meaning
  if (!used.has('word') && fieldNames.length >= 1) {
    mapping[0] = 'word';
    used.add('word');
  }
  if (!used.has('meaning') && fieldNames.length >= 2) {
    const freeIdx = mapping.findIndex((f) => f === 'ignore');
    if (freeIdx !== -1) {
      mapping[freeIdx] = 'meaning';
    }
  }

  return mapping;
}

// ---------------------------------------------------------------------------
// .apkg Zip Extraction, DB Priority Selection & SQLite Schema Reader
// ---------------------------------------------------------------------------

export async function extractDatabaseFromApkgZip(apkgBytes: Uint8Array | ArrayBuffer): Promise<{
  dbSource: ApkgDbSourceKind;
  sqliteBytes: Uint8Array;
  skippedMediaCount: number;
  hasNewerDb: boolean;
}> {
  const zip = await JSZip.loadAsync(apkgBytes);
  const fileNames = Object.keys(zip.files);

  const file21b = zip.file('collection.anki21b');
  const file21 = zip.file('collection.anki21');
  const file2 = zip.file('collection.anki2');

  let dbSource: ApkgDbSourceKind;
  let sqliteBytes: Uint8Array;
  let hasNewerDb = false;

  if (file21b) {
    dbSource = 'collection.anki21b';
    hasNewerDb = true;
    const compressed = await file21b.async('uint8array');
    const isSqliteHeader =
      compressed.length >= 16 &&
      new TextDecoder('ascii').decode(compressed.subarray(0, 15)) === 'SQLite format 3';
    sqliteBytes = isSqliteHeader ? compressed : fzstdDecompress(compressed);
  } else if (file21) {
    dbSource = 'collection.anki21';
    hasNewerDb = true;
    sqliteBytes = await file21.async('uint8array');
  } else if (file2) {
    dbSource = 'collection.anki2';
    sqliteBytes = await file2.async('uint8array');
  } else {
    throw new Error(
      'Invalid .apkg package: missing collection.anki21b, collection.anki21, or collection.anki2.'
    );
  }

  // Count skipped media entries without failing on protobuf/zstd media manifests
  let manifestMediaCount = 0;
  const mediaFile = zip.file('media');
  if (mediaFile) {
    try {
      const rawMediaBytes = await mediaFile.async('uint8array');
      const mediaBytes = isZstdCompressed(rawMediaBytes)
        ? fzstdDecompress(rawMediaBytes)
        : rawMediaBytes;
      const text = new TextDecoder('utf-8', { fatal: false }).decode(mediaBytes).trim();
      if (text.startsWith('{')) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          manifestMediaCount = Object.keys(parsed).length;
        }
      }
    } catch {
      // Modern zstd protobuf media manifest or non-JSON; rely on zip entry count below
    }
  }

  const nonDbEntriesCount = fileNames.filter((name) => {
    const entry = zip.files[name];
    if (!entry || entry.dir) return false;
    const base = name.split('/').pop() || name;
    return (
      base !== 'collection.anki21b' &&
      base !== 'collection.anki21' &&
      base !== 'collection.anki2' &&
      base !== 'media' &&
      base !== 'meta'
    );
  }).length;

  return {
    dbSource,
    sqliteBytes,
    skippedMediaCount: Math.max(manifestMediaCount, nonDbEntriesCount),
    hasNewerDb,
  };
}

function sqliteTableExists(dbConn: InstanceType<SqlJsStatic['Database']>, tableName: string): boolean {
  const res = dbConn.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}';`
  );
  return Boolean(res[0]?.values?.length);
}

export function openAndInspectAnkiDb(
  sqliteBytes: Uint8Array,
  sqlJs: SqlJsStatic,
  dbSource: ApkgDbSourceKind,
  skippedMediaCount: number,
  hasNewerDb: boolean
): {
  dbConn: InstanceType<SqlJsStatic['Database']>;
  summary: ApkgInspectSummary;
  deckNameById: Map<string, string>;
  modelFieldNamesById: Map<string, string[]>;
  modelNameById: Map<string, string>;
} {
  const dbConn = new sqlJs.Database(sqliteBytes);

  try {
    // Check for Anki dummy stub database when only collection.anki2 was provided
    if (!hasNewerDb && dbSource === 'collection.anki2') {
      const noteCheck = dbConn.exec('SELECT flds FROM notes LIMIT 5;');
      const rows = noteCheck[0]?.values || [];
      const hasDummyMsg = rows.some((r) =>
        String(r[0] || '').includes(ANKI_DUMMY_UPDATE_MESSAGE)
      );
      if (hasDummyMsg && rows.length <= 2) {
        throw new Error(ANKI_REEXPORT_HELP_MESSAGE);
      }
    }

    const deckNameById = new Map<string, string>();
    const modelFieldNamesById = new Map<string, string[]>();
    const modelNameById = new Map<string, string>();

    // 1. Read col.decks / col.models JSON when present
    if (sqliteTableExists(dbConn, 'col')) {
      const colRes = dbConn.exec('SELECT models, decks FROM col LIMIT 1;');
      const colRow = colRes[0]?.values?.[0];
      if (colRow) {
        const modelsStr = String(colRow[0] || '').trim();
        const decksStr = String(colRow[1] || '').trim();

        if (modelsStr.startsWith('{')) {
          try {
            const modelsJson = JSON.parse(modelsStr) as Record<string, any>;
            for (const [mid, modelObj] of Object.entries(modelsJson)) {
              if (!modelObj) continue;
              modelNameById.set(mid, String(modelObj.name || `Note Type ${mid}`));
              const flds = Array.isArray(modelObj.flds)
                ? [...modelObj.flds]
                    .sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))
                    .map((f) => String(f.name || `Field ${(f.ord ?? 0) + 1}`))
                : [];
              modelFieldNamesById.set(mid, flds);
            }
          } catch {
            // Fall through to modern tables if col.models isn't valid JSON
          }
        }

        if (decksStr.startsWith('{')) {
          try {
            const decksJson = JSON.parse(decksStr) as Record<string, any>;
            for (const [did, deckObj] of Object.entries(decksJson)) {
              if (!deckObj) continue;
              const cleanName = String(deckObj.name || 'Default').replace(/\x1f/g, '::');
              deckNameById.set(did, cleanName);
            }
          } catch {
            // Fall through to modern tables
          }
        }
      }
    }

    // 2. Modern Anki 2.1.50+ (.anki21b) normalized tables: notetypes, fields, decks
    if (modelFieldNamesById.size === 0 && sqliteTableExists(dbConn, 'notetypes')) {
      const ntRes = dbConn.exec('SELECT id, name FROM notetypes;');
      for (const row of ntRes[0]?.values || []) {
        const id = String(row[0]);
        modelNameById.set(id, String(row[1] || `Note Type ${id}`));
        modelFieldNamesById.set(id, []);
      }

      if (sqliteTableExists(dbConn, 'fields')) {
        const fRes = dbConn.exec('SELECT ntid, ord, name FROM fields ORDER BY ntid ASC, ord ASC;');
        for (const row of fRes[0]?.values || []) {
          const ntid = String(row[0]);
          const list = modelFieldNamesById.get(ntid) || [];
          list.push(String(row[2] || `Field ${Number(row[1]) + 1}`));
          modelFieldNamesById.set(ntid, list);
        }
      }
    }

    if (deckNameById.size === 0 && sqliteTableExists(dbConn, 'decks')) {
      const dRes = dbConn.exec('SELECT id, name FROM decks;');
      for (const row of dRes[0]?.values || []) {
        const id = String(row[0]);
        const name = String(row[1] || 'Default').replace(/\x1f/g, '::');
        deckNameById.set(id, name);
      }
    }

    if (!deckNameById.has('1')) {
      deckNameById.set('1', 'Default');
    }

    // 3. Count notes, note counts per deck & model, and capture sample fields per model
    const totalNotes = Number(
      dbConn.exec('SELECT COUNT(*) FROM notes;')[0]?.values?.[0]?.[0] ?? 0
    );

    const noteCountByModel = new Map<string, number>();
    const modelCountsRes = dbConn.exec('SELECT mid, COUNT(*) FROM notes GROUP BY mid;');
    for (const row of modelCountsRes[0]?.values || []) {
      noteCountByModel.set(String(row[0]), Number(row[1]));
    }

    const noteCountByDeck = new Map<string, number>();
    const deckCountsRes = dbConn.exec(
      'SELECT did, COUNT(DISTINCT nid) FROM cards GROUP BY did;'
    );
    for (const row of deckCountsRes[0]?.values || []) {
      noteCountByDeck.set(String(row[0]), Number(row[1]));
    }

    const noteTypes: ApkgNoteTypeInfo[] = [];
    for (const [mid, count] of noteCountByModel.entries()) {
      let fieldNames = modelFieldNamesById.get(mid) || [];
      const sampleRes = dbConn.exec(
        `SELECT flds FROM notes WHERE mid = ${Number(mid) || 0} LIMIT 1;`
      );
      const sampleRaw = String(sampleRes[0]?.values?.[0]?.[0] || '');
      const sampleFields = sampleRaw ? sampleRaw.split('\x1f') : [];

      if (fieldNames.length === 0 && sampleFields.length > 0) {
        fieldNames = sampleFields.map((_, idx) => `Field ${idx + 1}`);
        modelFieldNamesById.set(mid, fieldNames);
      }

      noteTypes.push({
        id: mid,
        name: modelNameById.get(mid) || `Note Type ${mid}`,
        fieldNames,
        noteCount: count,
        sampleFields,
        defaultMapping: detectDefaultApkgFieldMapping(fieldNames),
      });
    }

    // Sort noteTypes by highest noteCount first
    noteTypes.sort((a, b) => b.noteCount - a.noteCount);

    const decks: ApkgDeckInfo[] = [];
    for (const [did, name] of deckNameById.entries()) {
      const count = noteCountByDeck.get(did) || 0;
      if (count > 0 || did !== '1') {
        decks.push({ id: did, name, noteCount: count });
      }
    }
    decks.sort((a, b) => b.noteCount - a.noteCount || a.name.localeCompare(b.name));

    // Extract overall first sample note
    let sampleNote: ApkgInspectSummary['sampleNote'];
    const firstNoteRes = dbConn.exec(
      'SELECT id, mid, tags, flds FROM notes ORDER BY id ASC LIMIT 1;'
    );
    const firstRow = firstNoteRes[0]?.values?.[0];
    if (firstRow) {
      const nid = Number(firstRow[0]);
      const mid = String(firstRow[1]);
      const tagsRaw = String(firstRow[2] || '').trim();
      const rawFields = String(firstRow[3] || '').split('\x1f');
      const cardDidRes = dbConn.exec(`SELECT did FROM cards WHERE nid = ${nid} LIMIT 1;`);
      const did = String(cardDidRes[0]?.values?.[0]?.[0] ?? '1');
      const fNames = modelFieldNamesById.get(mid) || rawFields.map((_, i) => `Field ${i + 1}`);

      sampleNote = {
        noteTypeName: modelNameById.get(mid) || `Note Type ${mid}`,
        deckName: deckNameById.get(did) || 'Default',
        tags: tagsRaw ? tagsRaw.split(/\s+/).filter(Boolean) : [],
        fields: rawFields.map((raw, idx) => ({
          name: fNames[idx] || `Field ${idx + 1}`,
          raw,
          safeHtml: sanitizeAnkiHtml(raw),
          plainText: ankiHtmlToPlainText(raw),
        })),
      };
    }

    return {
      dbConn,
      summary: {
        dbSource,
        totalNotes,
        skippedMediaCount,
        decks,
        noteTypes,
        sampleNote,
      },
      deckNameById,
      modelFieldNamesById,
      modelNameById,
    };
  } catch (err) {
    dbConn.close();
    throw err;
  }
}

/**
 * Streams raw Anki note records in SQLite chunks (`batchSize`) so 10,000+ notes
 * never require loading all note payloads into one giant array in memory.
 */
export async function streamAnkiNoteBatches(
  dbConn: InstanceType<SqlJsStatic['Database']>,
  deckNameById: Map<string, string>,
  batchSize: number,
  onBatch: (batch: RawApkgNoteRecord[], processedSoFar: number, total: number) => Promise<void> | void,
  isCancelled?: () => boolean
): Promise<void> {
  // Build fast nid -> did lookup map from cards
  const nidToDid = new Map<number, string>();
  const cardStmt = dbConn.prepare('SELECT nid, did FROM cards;');
  try {
    while (cardStmt.step()) {
      const row = cardStmt.get();
      const nid = Number(row[0]);
      if (!nidToDid.has(nid)) {
        nidToDid.set(nid, String(row[1]));
      }
    }
  } finally {
    cardStmt.free();
  }

  const total = Number(
    dbConn.exec('SELECT COUNT(*) FROM notes;')[0]?.values?.[0]?.[0] ?? 0
  );

  const noteStmt = dbConn.prepare('SELECT id, mid, tags, flds FROM notes ORDER BY id ASC;');
  let batch: RawApkgNoteRecord[] = [];
  let processed = 0;

  try {
    while (noteStmt.step()) {
      if (isCancelled?.()) break;
      const row = noteStmt.get();
      const noteId = Number(row[0]);
      const modelId = String(row[1]);
      const tags = String(row[2] || '');
      const flds = String(row[3] || '');
      const did = nidToDid.get(noteId) || '1';
      const deckName = deckNameById.get(did) || 'Default';

      batch.push({
        noteId,
        modelId,
        deckId: did,
        deckName,
        tags,
        fields: flds.split('\x1f'),
      });
      processed += 1;

      if (batch.length >= batchSize) {
        await onBatch(batch, processed, total);
        batch = [];
      }
    }

    if (batch.length > 0 && !isCancelled?.()) {
      await onBatch(batch, processed, total);
    }
  } finally {
    noteStmt.free();
  }
}

// ---------------------------------------------------------------------------
// Main-Thread Dexie Writer for Streamed .apkg Batches
// ---------------------------------------------------------------------------

export interface ApkgWriteSessionContext {
  options: ApkgImportOptions;
  resolvedTargetDeckId: string;
  deckByName: Map<string, DeckItem>;
  existingCardByKey: Map<string, CardItem>;
  createdDeckNames: string[];
  modelNameById: Map<string, string>;
}

export async function createApkgWriteSession(
  options: ApkgImportOptions,
  modelNameById: Map<string, string>
): Promise<ApkgWriteSessionContext> {
  let resolvedTargetDeckId = options.targetDeckId || '';
  const createdDeckNames: string[] = [];

  if (options.deckMode === 'target') {
    if (options.newDeckName && options.newDeckName.trim()) {
      const desired = options.newDeckName.trim();
      const existingDecks = await db.decks
        .where('languageId')
        .equals(options.languageId)
        .toArray();
      const match = existingDecks.find(
        (d) => d.name.trim().toLowerCase() === desired.toLowerCase()
      );
      if (match) {
        resolvedTargetDeckId = match.id;
      } else {
        const created: DeckItem = {
          id: generateEntityId('deck'),
          name: desired,
          languageId: options.languageId,
          createdAt: Date.now(),
          description: 'Imported from Anki (.apkg)',
        };
        await db.decks.put(created);
        resolvedTargetDeckId = created.id;
        createdDeckNames.push(desired);
      }
    } else if (!resolvedTargetDeckId) {
      const def = await ensureDefaultDeck(options.languageId);
      resolvedTargetDeckId = def.id;
    }
  } else {
    const def = await ensureDefaultDeck(options.languageId);
    resolvedTargetDeckId = def.id;
  }

  const allDecks = await db.decks.where('languageId').equals(options.languageId).toArray();
  const deckByName = new Map<string, DeckItem>();
  for (const d of allDecks) {
    deckByName.set(d.name.trim().toLowerCase(), d);
  }

  const allCards = await db.cards.where('languageId').equals(options.languageId).toArray();
  const existingCardByKey = new Map<string, CardItem>();
  for (const c of allCards) {
    const k = `${(c.lemma || c.word).trim()}\x1e${(c.reading || '').trim()}\x1e${c.cardType}`;
    if (!existingCardByKey.has(k)) {
      existingCardByKey.set(k, c);
    }
  }

  return {
    options,
    resolvedTargetDeckId,
    deckByName,
    existingCardByKey,
    createdDeckNames,
    modelNameById,
  };
}

export async function processApkgNoteBatch(
  batch: RawApkgNoteRecord[],
  ctx: ApkgWriteSessionContext
): Promise<{
  created: number;
  updated: number;
  skippedDuplicates: number;
  failed: ApkgFailedNote[];
}> {
  let created = 0;
  let updated = 0;
  let skippedDuplicates = 0;
  const failed: ApkgFailedNote[] = [];
  const toWrite: CardItem[] = [];
  const batchBaseTime = Date.now();

  const resolveDeckForNote = async (ankiDeckName: string): Promise<string> => {
    if (ctx.options.deckMode === 'target') {
      return ctx.resolvedTargetDeckId;
    }
    const clean = (ankiDeckName || 'Default').trim() || 'Default';
    const key = clean.toLowerCase();
    const cached = ctx.deckByName.get(key);
    if (cached) return cached.id;

    const newDeck: DeckItem = {
      id: generateEntityId('deck'),
      name: clean,
      languageId: ctx.options.languageId,
      createdAt: Date.now(),
      description: 'Imported from Anki (.apkg)',
    };
    await db.decks.put(newDeck);
    ctx.deckByName.set(key, newDeck);
    ctx.createdDeckNames.push(clean);
    return newDeck.id;
  };

  for (let i = 0; i < batch.length; i++) {
    const rec = batch[i];
    const modelName = ctx.modelNameById.get(rec.modelId) || rec.modelId;
    const mapping = ctx.options.modelMappings[rec.modelId] || [];

    try {
      let rawWordHtml = '';
      let rawReadingHtml = '';
      let rawMeaningHtml = '';
      let rawSentenceHtml = '';
      const rawNotesParts: string[] = [];
      const extraTagParts: string[] = [];

      for (let colIdx = 0; colIdx < mapping.length; colIdx++) {
        const targetField = mapping[colIdx];
        if (!targetField || targetField === 'ignore') continue;
        const val = rec.fields[colIdx] || '';
        if (!val.trim()) continue;

        switch (targetField) {
          case 'word':
            if (!rawWordHtml) rawWordHtml = val;
            break;
          case 'reading':
            if (!rawReadingHtml) rawReadingHtml = val;
            break;
          case 'meaning':
            rawMeaningHtml = rawMeaningHtml ? `${rawMeaningHtml}; ${val}` : val;
            break;
          case 'sentence':
            if (!rawSentenceHtml) rawSentenceHtml = val;
            break;
          case 'notes':
            rawNotesParts.push(ankiHtmlToPlainText(val));
            break;
          case 'tags':
            extraTagParts.push(ankiHtmlToPlainText(val));
            break;
        }
      }

      const parsedWord = parseAnkiFuriganaField(rawWordHtml);
      const cleanWord = parsedWord.plainText.trim();

      if (!cleanWord) {
        failed.push({
          noteId: rec.noteId,
          modelName,
          word: '',
          reason: "Missing required 'word' field.",
          rawFields: rec.fields,
        });
        continue;
      }

      const parsedReading = parseAnkiFuriganaField(rawReadingHtml);
      const cleanReading = (parsedReading.plainText || parsedWord.reading || '').trim();
      const cleanMeaning = ankiHtmlToPlainText(rawMeaningHtml);

      if (ctx.options.cardType !== 'reading' && mapping.includes('meaning') && !cleanMeaning) {
        failed.push({
          noteId: rec.noteId,
          modelName,
          word: cleanWord,
          reason: "Missing 'meaning' value for selected card type.",
          rawFields: rec.fields,
        });
        continue;
      }

      if (ctx.options.cardType === 'reading' && !cleanReading) {
        failed.push({
          noteId: rec.noteId,
          modelName,
          word: cleanWord,
          reason: "Missing 'reading' value for Reading card.",
          rawFields: rec.fields,
        });
        continue;
      }

      // Build word furiganaSegments from <ruby>, bracket notation, or reading alignment
      let wordFurigana = parsedWord.segments;
      if (
        (!wordFurigana || wordFurigana.length === 0) &&
        cleanReading &&
        /[\u4e00-\u9faf\u3400-\u4dbf々〆〇]/.test(cleanWord)
      ) {
        wordFurigana = buildFurigana(cleanWord, cleanReading, cleanWord);
      }

      // Parse sentence furigana if bracket/ruby markup is present
      const parsedSentence = parseAnkiFuriganaField(rawSentenceHtml);
      const cleanSentence = (parsedSentence.plainText || ankiHtmlToPlainText(rawSentenceHtml)).trim();
      const sentenceFurigana = parsedSentence.segments;

      const noteTags = parseTagsCell(rec.tags);
      const mappedTags = extraTagParts.flatMap((t) => parseTagsCell(t));
      const allTags = Array.from(new Set([...noteTags, ...mappedTags]));
      const cleanNotes = rawNotesParts.filter(Boolean).join('\n');

      const deckId = await resolveDeckForNote(rec.deckName);
      const lemma = cleanWord;
      const dupKey = `${lemma}\x1e${cleanReading}\x1e${ctx.options.cardType}`;
      const existingDup = ctx.existingCardByKey.get(dupKey);

      if (existingDup && ctx.options.duplicateMode === 'skip') {
        skippedDuplicates += 1;
        continue;
      }

      const now = batchBaseTime + i;

      if (existingDup && ctx.options.duplicateMode === 'update') {
        const mergedTags =
          allTags.length > 0
            ? Array.from(new Set([...(existingDup.tags || []), ...allTags]))
            : existingDup.tags || [];

        const updatedCard: CardItem = {
          ...existingDup,
          deckId: ctx.options.deckMode === 'keep' ? deckId : ctx.resolvedTargetDeckId,
          word: cleanWord,
          lemma,
          reading: cleanReading,
          furiganaSegments: wordFurigana ?? existingDup.furiganaSegments,
          meaning: cleanMeaning || existingDup.meaning,
          sentence: cleanSentence || existingDup.sentence || '',
          sentenceFuriganaSegments: sentenceFurigana ?? existingDup.sentenceFuriganaSegments,
          tags: mergedTags,
          notes: cleanNotes || existingDup.notes || '',
          updatedAt: now,
        };
        toWrite.push(updatedCard);
        ctx.existingCardByKey.set(dupKey, updatedCard);
        updated += 1;
        continue;
      }

      // Import strictly as New card (FSRS/SM-2 scheduling from Anki is NEVER imported)
      const newCard: CardItem = {
        id: generateEntityId('card'),
        deckId,
        languageId: ctx.options.languageId,
        cardType: ctx.options.cardType,
        word: cleanWord,
        lemma,
        reading: cleanReading,
        furiganaSegments: wordFurigana,
        meaning: cleanMeaning,
        partOfSpeech: '',
        level: '',
        frequencyBand: '',
        sentence: cleanSentence,
        sentenceFuriganaSegments: sentenceFurigana,
        sourceDocTitle: '',
        tags: allTags,
        notes: cleanNotes,
        createdAt: now,
        updatedAt: now,
        suspended: false,
        buried: false,
        due: now,
        stability: 0,
        difficulty: 0,
        reps: 0,
        lapses: 0,
        state: 0,
        scheduledDays: 0,
        elapsedDays: 0,
        learningSteps: 0,
      };

      toWrite.push(newCard);
      if (!ctx.existingCardByKey.has(dupKey)) {
        ctx.existingCardByKey.set(dupKey, newCard);
      }
      created += 1;
    } catch (err: any) {
      failed.push({
        noteId: rec.noteId,
        modelName,
        word: (rec.fields[0] || '').slice(0, 40),
        reason: err?.message || 'Failed to import note.',
        rawFields: rec.fields,
      });
    }
  }

  if (toWrite.length > 0) {
    await db.cards.bulkPut(toWrite);
  }

  return { created, updated, skippedDuplicates, failed };
}

export async function finalizeApkgImportSideEffects(
  result: ApkgImportResult,
  languageId: string
): Promise<void> {
  if (result.cardsCreated > 0 || result.cardsUpdated > 0) {
    invalidateStatsCache();
    await logEvent('cards_apkg_imported', {
      languageId,
      notesRead: result.notesRead,
      cardsCreated: result.cardsCreated,
      cardsUpdated: result.cardsUpdated,
      skippedDuplicates: result.skippedDuplicates,
      skippedMediaCount: result.skippedMediaCount,
      errorsCount: result.failedNotes.length,
    }).catch(() => {});
  }
}

export function buildFailedApkgNotesCsv(failedNotes: ApkgFailedNote[]): {
  fileName: string;
  bytes: Uint8Array;
} {
  const esc = (v: string) => {
    const clean = (v || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return clean.includes(',') || clean.includes('"') || clean.includes('\n')
      ? `"${clean.replace(/"/g, '""')}"`
      : clean;
  };
  const header = ['NoteId', 'NoteType', 'Word', 'ErrorReason', 'FieldsPreview'].join(',');
  const lines = [header];
  for (const f of failedNotes) {
    lines.push(
      [
        String(f.noteId),
        esc(f.modelName),
        esc(f.word),
        esc(f.reason),
        esc(f.rawFields.join(' | ')),
      ].join(',')
    );
  }
  const text = `\uFEFF${lines.join('\n')}`;
  return {
    fileName: `linguaforge-apkg-import-errors-${new Date().toISOString().slice(0, 10)}.csv`,
    bytes: new TextEncoder().encode(text),
  };
}
