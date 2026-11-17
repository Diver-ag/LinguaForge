import { db, type CardItem, type CardType, type DeckItem } from '../db/db';
import { ensureDefaultDeck, generateEntityId } from '../db/cards';
import { packSupportsRuby, type FuriganaSegment, type Token } from './languagePack';
import { buildFurigana } from '../packs/japanese/kanaUtils';
import { buildMandarinPinyinSegments } from '../packs/multilingualPack';
import { invalidateStatsCache } from './statsCache';
import { logEvent } from './eventLogger';

export type CsvDelimiter = ',' | '\t' | ';' | '|';

export type ImportCardField =
  | 'ignore'
  | 'word'
  | 'reading'
  | 'meaning'
  | 'sentence'
  | 'tags'
  | 'notes'
  | 'level'
  | 'deck';

export type DuplicateImportMode = 'skip' | 'update' | 'allow';

export const IMPORT_CARD_FIELD_OPTIONS: {
  value: ImportCardField;
  label: string;
}[] = [
  { value: 'ignore', label: 'Skip / Ignore' },
  { value: 'word', label: 'Word (required)' },
  { value: 'reading', label: 'Reading' },
  { value: 'meaning', label: 'Meaning' },
  { value: 'sentence', label: 'Sentence' },
  { value: 'tags', label: 'Tags' },
  { value: 'notes', label: 'Notes' },
  { value: 'level', label: 'Level (JLPT / CEFR)' },
  { value: 'deck', label: 'Deck' },
];

export const CARD_IMPORT_MAPPINGS_SETTINGS_KEY = 'cardCsvImportMappings';

export interface SavedImportLayout {
  layoutKey: string;
  mapping: ImportCardField[];
  hasHeaderRow: boolean;
  delimiter: CsvDelimiter;
  updatedAt: number;
}

export interface DecodedTextResult {
  text: string;
  encodingLabel: 'UTF-8' | 'UTF-8 with BOM' | 'UTF-16LE' | 'UTF-16BE';
  hasBom: boolean;
}

/**
 * Decodes an uploaded file buffer, detecting UTF-8 BOM (EF BB BF), UTF-16 BOMs,
 * or plain UTF-8 without BOM, and strips any leading BOM character.
 */
export function decodeUploadedTextBuffer(buffer: ArrayBuffer): DecodedTextResult {
  const bytes = new Uint8Array(buffer);

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(3)).replace(/^\uFEFF/, '');
    return { text, encodingLabel: 'UTF-8 with BOM', hasBom: true };
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = new TextDecoder('utf-16le').decode(bytes.subarray(2)).replace(/^\uFEFF/, '');
    return { text, encodingLabel: 'UTF-16LE', hasBom: true };
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = new TextDecoder('utf-16be').decode(bytes.subarray(2)).replace(/^\uFEFF/, '');
    return { text, encodingLabel: 'UTF-16BE', hasBom: true };
  }

  const raw = new TextDecoder('utf-8').decode(bytes);
  const hasBom = raw.startsWith('\uFEFF');
  return {
    text: hasBom ? raw.slice(1) : raw,
    encodingLabel: hasBom ? 'UTF-8 with BOM' : 'UTF-8',
    hasBom,
  };
}

function splitSampleLines(text: string, maxLines = 15): string[] {
  const lines: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        cur += ch;
      }
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (cur.trim().length > 0) {
        lines.push(cur);
        if (lines.length >= maxLines) break;
      }
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0 && lines.length < maxLines) {
    lines.push(cur);
  }
  return lines;
}

function countDelimitedFields(line: string, delimiter: CsvDelimiter): number {
  let count = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      count++;
    }
  }
  return count;
}

/**
 * Detects delimiter among Tab, Comma, Semicolon, and Pipe using quoted-aware
 * column count consistency across sample lines.
 */
export function detectCsvDelimiter(text: string, fileName = ''): CsvDelimiter {
  const sampleLines = splitSampleLines(text, 15);
  const candidates: CsvDelimiter[] = ['\t', ',', ';', '|'];
  const lowerName = fileName.toLowerCase();

  if (sampleLines.length === 0) {
    return lowerName.endsWith('.tsv') ? '\t' : ',';
  }

  let bestDelim: CsvDelimiter = lowerName.endsWith('.tsv') ? '\t' : ',';
  let bestScore = -1;

  for (const delim of candidates) {
    const counts = sampleLines.map((l) => countDelimitedFields(l, delim));
    const multiColLines = counts.filter((c) => c >= 2).length;
    if (multiColLines === 0) continue;

    // Mode frequency + consistency reward
    const freqMap = new Map<number, number>();
    for (const c of counts) {
      if (c >= 2) freqMap.set(c, (freqMap.get(c) || 0) + 1);
    }
    let modeCols = 2;
    let modeFreq = 0;
    for (const [cols, freq] of freqMap.entries()) {
      if (freq > modeFreq) {
        modeFreq = freq;
        modeCols = cols;
      }
    }

    const consistencyRatio = modeFreq / sampleLines.length;
    const extensionBonus =
      (lowerName.endsWith('.tsv') && delim === '\t') ||
      (lowerName.endsWith('.csv') && delim === ',')
        ? 0.5
        : 0;
    const tabTieBreaker = delim === '\t' ? 0.15 : delim === ',' ? 0.1 : 0;
    const score = consistencyRatio * 10 + Math.min(modeCols, 12) * 0.25 + extensionBonus + tabTieBreaker;

    if (score > bestScore) {
      bestScore = score;
      bestDelim = delim;
    }
  }

  return bestDelim;
}

/**
 * RFC-4180 style delimited parser supporting multi-line quoted values,
 * escaped quotes (""), and CRLF/LF/CR line endings.
 */
export function parseDelimitedText(text: string, delimiter: CsvDelimiter): string[][] {
  const cleanText = text.replace(/^\uFEFF/, '');
  if (!cleanText.trim()) return [];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStartedQuoted = false;

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];

    if (inQuotes) {
      if (ch === '"') {
        if (cleanText[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0 && !fieldStartedQuoted) {
      inQuotes = true;
      fieldStartedQuoted = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(field.trim().normalize('NFC'));
      field = '';
      fieldStartedQuoted = false;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && cleanText[i + 1] === '\n') {
        i++;
      }
      row.push(field.trim().normalize('NFC'));
      field = '';
      fieldStartedQuoted = false;
      if (row.some((cell) => cell !== '')) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    field += ch;
  }

  // Final cell / row
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim().normalize('NFC'));
    if (row.some((cell) => cell !== '')) {
      rows.push(row);
    }
  }

  return rows;
}

const HEADER_MATCHERS: { field: ImportCardField; exact: string[]; partial: string[] }[] = [
  {
    field: 'word',
    exact: ['word', 'expression', 'kanji', 'vocab', 'vocabulary', 'term', 'front', 'lemma'],
    partial: ['word', 'expression', 'vocab', 'kanji'],
  },
  {
    field: 'reading',
    exact: ['reading', 'readings', 'kana', 'hiragana', 'katakana', 'pronunciation', 'yomi', 'furigana'],
    partial: ['reading', 'kana', 'pronun'],
  },
  {
    field: 'meaning',
    exact: ['meaning', 'meanings', 'definition', 'definitions', 'gloss', 'glosses', 'english', 'translation', 'back'],
    partial: ['meaning', 'definit', 'gloss', 'translat'],
  },
  {
    field: 'sentence',
    exact: ['sentence', 'example', 'context', 'examplesentence', 'example_sentence'],
    partial: ['sentence', 'example', 'context'],
  },
  {
    field: 'tags',
    exact: ['tag', 'tags', 'labels'],
    partial: ['tag'],
  },
  {
    field: 'notes',
    exact: ['note', 'notes', 'memo', 'comment', 'comments', 'hint'],
    partial: ['note', 'memo', 'comment'],
  },
  {
    field: 'level',
    exact: ['level', 'jlpt', 'cefr', 'grade', 'jlptlevel', 'jlpt_level'],
    partial: ['level', 'jlpt', 'cefr'],
  },
  {
    field: 'deck',
    exact: ['deck', 'deckname', 'deck_name', 'category', 'list'],
    partial: ['deck'],
  },
];

export function detectHasHeaderRow(firstRow: string[]): boolean {
  if (!firstRow || firstRow.length === 0) return false;
  const normalized = firstRow.map((c) => c.trim().toLowerCase().replace(/[\s_-]+/g, ''));
  let hits = 0;
  for (const cell of normalized) {
    if (!cell) continue;
    for (const matcher of HEADER_MATCHERS) {
      if (matcher.exact.some((k) => k.replace(/[\s_-]+/g, '') === cell)) {
        hits++;
        break;
      }
    }
  }
  return hits >= 1;
}

export function detectDefaultColumnMapping(
  headers: string[],
  hasHeaderRow: boolean,
  colCount: number
): ImportCardField[] {
  const mapping: ImportCardField[] = Array.from({ length: colCount }, () => 'ignore');
  const usedFields = new Set<ImportCardField>();

  if (hasHeaderRow) {
    const cleanHeaders = headers.map((h) => h.trim().toLowerCase());
    // Skip FuriganaHTML / SentenceFuriganaHTML auto-collision in favor of Word/Reading/Sentence
    for (let i = 0; i < colCount; i++) {
      const h = cleanHeaders[i] || '';
      const compact = h.replace(/[\s_-]+/g, '');
      if (!compact) continue;
      if (compact === 'furiganahtml' || compact === 'furiganaanki' || compact === 'sentencefuriganahtml') {
        continue;
      }

      for (const matcher of HEADER_MATCHERS) {
        if (usedFields.has(matcher.field)) continue;
        if (matcher.exact.includes(h) || matcher.exact.includes(compact)) {
          mapping[i] = matcher.field;
          usedFields.add(matcher.field);
          break;
        }
      }
    }

    // Second pass: partial matches
    for (let i = 0; i < colCount; i++) {
      if (mapping[i] !== 'ignore') continue;
      const h = cleanHeaders[i] || '';
      const compact = h.replace(/[\s_-]+/g, '');
      if (!compact || compact.includes('furiganahtml') || compact.includes('furiganaanki')) continue;

      for (const matcher of HEADER_MATCHERS) {
        if (usedFields.has(matcher.field)) continue;
        if (matcher.partial.some((p) => compact.includes(p))) {
          mapping[i] = matcher.field;
          usedFields.add(matcher.field);
          break;
        }
      }
    }
  } else {
    // Positional fallback for headerless TSV/CSV files
    if (colCount >= 1) mapping[0] = 'word';
    if (colCount === 2) {
      mapping[1] = 'meaning';
    } else if (colCount >= 3) {
      mapping[1] = 'reading';
      mapping[2] = 'meaning';
      if (colCount >= 4) mapping[3] = 'sentence';
      if (colCount >= 5) mapping[4] = 'tags';
    }
  }

  return mapping;
}

export function computeLayoutSignature(
  headers: string[],
  hasHeaderRow: boolean,
  colCount: number,
  delimiter: CsvDelimiter
): string {
  if (hasHeaderRow && headers.length > 0) {
    const norm = headers.map((h) => h.trim().toLowerCase()).join('|');
    return `hdr:${colCount}:${delimiter}:${norm}`;
  }
  return `pos:${colCount}:${delimiter}`;
}

export async function loadSavedColumnMappings(): Promise<Record<string, SavedImportLayout>> {
  try {
    const item = await db.settings.get(CARD_IMPORT_MAPPINGS_SETTINGS_KEY);
    if (item && item.value && typeof item.value === 'object') {
      return item.value as Record<string, SavedImportLayout>;
    }
  } catch {
    // Ignore storage read errors
  }
  return {};
}

export async function saveColumnMappingForLayout(layout: SavedImportLayout): Promise<void> {
  try {
    const current = await loadSavedColumnMappings();
    current[layout.layoutKey] = layout;
    await db.settings.put({
      key: CARD_IMPORT_MAPPINGS_SETTINGS_KEY,
      value: current,
    });
  } catch (err) {
    console.warn('Could not persist column mapping layout:', err);
  }
}

// ---------------------------------------------------------------------------
// Inline Furigana Parser & Tokenizer Enrichment
// ---------------------------------------------------------------------------

/**
 * Parses `<ruby>漢字<rt>かんじ</rt></ruby>` or Anki `漢字[かんじ]` strings into
 * plain word text, kana reading, and `FuriganaSegment[]`.
 */
export function parseInlineFurigana(raw: string): {
  plainText: string;
  reading?: string;
  segments?: FuriganaSegment[];
} {
  const input = (raw || '').trim();
  if (!input) return { plainText: '' };

  // 1. Check for <ruby>...<rt>...</rt></ruby> HTML markup
  if (/<ruby\b/i.test(input)) {
    const segments: FuriganaSegment[] = [];
    const rubyRegex = /<ruby\b[^>]*>([\s\S]*?)<rt\b[^>]*>([\s\S]*?)<\/rt>[\s\S]*?<\/ruby>/gi;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let plainText = '';
    let reading = '';

    while ((match = rubyRegex.exec(input)) !== null) {
      if (match.index > lastIndex) {
        const prefix = input.slice(lastIndex, match.index).replace(/<[^>]*>/g, '');
        if (prefix) {
          segments.push({ text: prefix });
          plainText += prefix;
          reading += prefix;
        }
      }
      const base = match[1].replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '').replace(/<[^>]*>/g, '');
      const rt = match[2].replace(/<[^>]*>/g, '');
      if (base) {
        segments.push(rt ? { text: base, ruby: rt } : { text: base });
        plainText += base;
        reading += rt || base;
      }
      lastIndex = rubyRegex.lastIndex;
    }

    if (lastIndex < input.length) {
      const tail = input.slice(lastIndex).replace(/<[^>]*>/g, '');
      if (tail) {
        segments.push({ text: tail });
        plainText += tail;
        reading += tail;
      }
    }

    if (segments.some((s) => Boolean(s.ruby))) {
      return {
        plainText: plainText.trim(),
        reading: reading.trim() || undefined,
        segments,
      };
    }
  }

  // 2. Check for Anki bracket notation e.g. `食[た]べる` or `日[に] 本[ほん]`
  if (/[^\s\[]+\[[^\]]+\]/.test(input)) {
    const segments: FuriganaSegment[] = [];
    const bracketRegex = /([^\s\[]+)\[([^\]]+)\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let plainText = '';
    let reading = '';

    while ((match = bracketRegex.exec(input)) !== null) {
      if (match.index > lastIndex) {
        const between = input.slice(lastIndex, match.index);
        // Collapse single separator space added by Anki bracket formatting before kanji groups
        const cleanBetween = between === ' ' ? '' : between;
        if (cleanBetween) {
          segments.push({ text: cleanBetween });
          plainText += cleanBetween;
          reading += cleanBetween;
        }
      }
      const base = match[1];
      const rt = match[2];
      segments.push({ text: base, ruby: rt });
      plainText += base;
      reading += rt;
      lastIndex = bracketRegex.lastIndex;
    }

    if (lastIndex < input.length) {
      const tail = input.slice(lastIndex);
      if (tail) {
        segments.push({ text: tail });
        plainText += tail;
        reading += tail;
      }
    }

    if (segments.length > 0) {
      return {
        plainText: plainText.trim(),
        reading: reading.trim() || undefined,
        segments,
      };
    }
  }

  // Strip stray non-ruby HTML tags if present
  const stripped = input.replace(/<[^>]*>/g, '').trim();
  return { plainText: stripped };
}

export async function enrichCardFuriganaAndMetadata(params: {
  word: string;
  reading: string;
  sentence: string;
  languageId: string;
  existingWordFurigana?: FuriganaSegment[];
  tokenizeFn?: (text: string) => Promise<Token[]>;
}): Promise<{
  lemma: string;
  reading: string;
  furiganaSegments?: FuriganaSegment[];
  sentenceFuriganaSegments?: FuriganaSegment[];
  partOfSpeech: string;
}> {
  let lemma = params.word;
  let reading = params.reading;
  const supportsRuby = packSupportsRuby({ id: params.languageId });
  let furiganaSegments = supportsRuby ? params.existingWordFurigana : undefined;
  let partOfSpeech = '';

  const hasKanji = /[\u4e00-\u9faf\u3400-\u4dbf々〆〇]/.test(params.word);

  if (params.languageId === 'zh' && (!furiganaSegments || furiganaSegments.length === 0) && params.word) {
    const py = buildMandarinPinyinSegments(params.word);
    if (!reading && py.reading) {
      reading = py.reading;
    }
    if (py.furiganaSegments && py.furiganaSegments.length > 0) {
      furiganaSegments = py.furiganaSegments;
    }
  }

  // Use tokenizer when furigana data is missing and reading is available (or to enrich lemma/sentence)
  if ((!furiganaSegments || furiganaSegments.length === 0) && params.word) {
    if (params.tokenizeFn) {
      try {
        const tokens = await params.tokenizeFn(params.word);
        const wordTokens = tokens.filter((t) => t.isWord);
        if (wordTokens.length === 1) {
          const tok = wordTokens[0];
          lemma = tok.baseForm || params.word;
          partOfSpeech = tok.partOfSpeech || '';
          if (!reading && tok.reading && tok.reading !== params.word) {
            reading = tok.reading;
          }
          if (supportsRuby) {
            if (params.languageId === 'zh') {
              furiganaSegments =
                buildMandarinPinyinSegments(params.word).furiganaSegments || tok.furiganaSegments;
            } else if (reading) {
              furiganaSegments =
                buildFurigana(params.word, reading, lemma) || tok.furiganaSegments;
            } else if (tok.furiganaSegments && tok.furiganaSegments.length > 0) {
              furiganaSegments = tok.furiganaSegments;
            }
          }
        } else if (wordTokens.length > 1 && supportsRuby) {
          // Compound expression tokenized into multiple tokens
          if (params.languageId === 'zh') {
            furiganaSegments = buildMandarinPinyinSegments(params.word).furiganaSegments;
          } else if (reading && hasKanji) {
            furiganaSegments = buildFurigana(params.word, reading, params.word);
          } else {
            const combined = tokens.flatMap(
              (t) => t.furiganaSegments || (t.surface ? [{ text: t.surface }] : [])
            );
            if (combined.some((s) => Boolean(s.ruby))) {
              furiganaSegments = combined;
            }
          }
        }
      } catch {
        // Fall through to buildFurigana fallback below
      }
    }

    if (supportsRuby && (!furiganaSegments || furiganaSegments.length === 0) && hasKanji && reading) {
      furiganaSegments =
        params.languageId === 'zh'
          ? buildMandarinPinyinSegments(params.word).furiganaSegments
          : buildFurigana(params.word, reading, lemma);
    }
  }

  let sentenceFuriganaSegments: FuriganaSegment[] | undefined;
  if (supportsRuby && params.sentence && params.tokenizeFn) {
    try {
      const sentTokens = await params.tokenizeFn(params.sentence);
      const segs = sentTokens.flatMap(
        (t) => t.furiganaSegments || (t.surface ? [{ text: t.surface }] : [])
      );
      if (segs.some((s) => Boolean(s.ruby))) {
        sentenceFuriganaSegments = segs;
      }
    } catch {
      sentenceFuriganaSegments = undefined;
    }
  }

  return {
    lemma: lemma || params.word,
    reading,
    furiganaSegments: supportsRuby ? furiganaSegments : undefined,
    sentenceFuriganaSegments: supportsRuby ? sentenceFuriganaSegments : undefined,
    partOfSpeech,
  };
}

// ---------------------------------------------------------------------------
// Tag Normalization & Batch Importer
// ---------------------------------------------------------------------------

export function parseTagsCell(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  // Support comma-separated or space-separated Anki tags
  const parts = raw.includes(',') ? raw.split(',') : raw.split(/\s+/);
  return Array.from(
    new Set(
      parts
        .map((t) => t.trim())
        .filter(Boolean)
    )
  );
}

export interface FailedImportRow {
  rowNumber: number; // 1-indexed row number in source file
  rawRow: string[];
  word: string;
  reason: string;
}

export interface CardCsvImportProgress {
  processed: number;
  total: number;
  percent: number;
}

export interface CardCsvImportOptions {
  languageId: string;
  mapping: ImportCardField[];
  hasHeaderRow: boolean;
  targetDeckId?: string;
  newDeckName?: string;
  cardType: CardType;
  duplicateMode: DuplicateImportMode;
  batchSize?: number;
}

export interface CardCsvImportResult {
  rowsRead: number;
  cardsCreated: number;
  cardsUpdated: number;
  skippedDuplicates: number;
  createdDeckNames: string[];
  failedRows: FailedImportRow[];
  cancelled: boolean;
}

function extractMappedRowValues(rawRow: string[], mapping: ImportCardField[]) {
  const out: Partial<Record<Exclude<ImportCardField, 'ignore'>, string>> = {};
  for (let i = 0; i < mapping.length; i++) {
    const field = mapping[i];
    if (!field || field === 'ignore') continue;
    const cell = (rawRow[i] || '').trim();
    if (!cell) continue;
    if (field === 'tags' && out.tags) {
      out.tags = `${out.tags}, ${cell}`;
    } else if (field === 'notes' && out.notes) {
      out.notes = `${out.notes}\n${cell}`;
    } else if (!out[field]) {
      out[field] = cell;
    }
  }
  return out;
}

export async function runCardCsvImport(
  allRows: string[][],
  options: CardCsvImportOptions,
  deps?: {
    tokenizeFn?: (text: string) => Promise<Token[]>;
    onProgress?: (progress: CardCsvImportProgress) => void;
    isCancelled?: () => boolean;
    skipSideEffects?: boolean;
  }
): Promise<CardCsvImportResult> {
  const startIdx = options.hasHeaderRow ? 1 : 0;
  const dataRows = allRows.slice(startIdx);
  const total = dataRows.length;
  const batchSize = Math.max(10, options.batchSize || 40);

  const result: CardCsvImportResult = {
    rowsRead: total,
    cardsCreated: 0,
    cardsUpdated: 0,
    skippedDuplicates: 0,
    createdDeckNames: [],
    failedRows: [],
    cancelled: false,
  };

  if (total === 0) {
    deps?.onProgress?.({ processed: 0, total: 0, percent: 100 });
    return result;
  }

  // Resolve or create target deck
  let resolvedTargetDeckId = options.targetDeckId || '';
  const createdDeckNames: string[] = [];

  if (options.newDeckName && options.newDeckName.trim()) {
    const desiredName = options.newDeckName.trim();
    const existingDecks = await db.decks
      .where('languageId')
      .equals(options.languageId)
      .toArray();
    const match = existingDecks.find(
      (d) => d.name.trim().toLowerCase() === desiredName.toLowerCase()
    );
    if (match) {
      resolvedTargetDeckId = match.id;
    } else {
      const createdDeck: DeckItem = {
        id: generateEntityId('deck'),
        name: desiredName,
        languageId: options.languageId,
        createdAt: Date.now(),
        description: 'Imported from CSV/TSV',
      };
      await db.decks.put(createdDeck);
      resolvedTargetDeckId = createdDeck.id;
      createdDeckNames.push(desiredName);
    }
  } else if (!resolvedTargetDeckId) {
    const defDeck = await ensureDefaultDeck(options.languageId);
    resolvedTargetDeckId = defDeck.id;
  }

  // Cache decks by lowercase name for row-level `deck` column mapping
  const existingDecks = await db.decks
    .where('languageId')
    .equals(options.languageId)
    .toArray();
  const deckByName = new Map<string, DeckItem>();
  for (const d of existingDecks) {
    deckByName.set(d.name.trim().toLowerCase(), d);
  }

  // Preload existing cards for fast in-memory duplicate matching (lemma + reading + cardType)
  const existingCards = await db.cards
    .where('languageId')
    .equals(options.languageId)
    .toArray();
  const existingCardByKey = new Map<string, CardItem>();
  for (const c of existingCards) {
    const k = `${(c.lemma || c.word).trim()}\x1e${(c.reading || '').trim()}\x1e${c.cardType}`;
    if (!existingCardByKey.has(k)) {
      existingCardByKey.set(k, c);
    }
  }

  const getOrCreateRowDeckId = async (deckNameRaw?: string): Promise<string> => {
    const clean = (deckNameRaw || '').trim();
    if (!clean) return resolvedTargetDeckId;
    const key = clean.toLowerCase();
    const cached = deckByName.get(key);
    if (cached) return cached.id;

    const newDeck: DeckItem = {
      id: generateEntityId('deck'),
      name: clean,
      languageId: options.languageId,
      createdAt: Date.now(),
      description: 'Imported from CSV/TSV',
    };
    await db.decks.put(newDeck);
    deckByName.set(key, newDeck);
    createdDeckNames.push(clean);
    return newDeck.id;
  };

  for (let offset = 0; offset < total; offset += batchSize) {
    if (deps?.isCancelled?.()) {
      result.cancelled = true;
      break;
    }

    const slice = dataRows.slice(offset, offset + batchSize);
    const toWrite: CardItem[] = [];
    const batchStartTime = Date.now();

    for (let j = 0; j < slice.length; j++) {
      if (deps?.isCancelled?.()) {
        result.cancelled = true;
        break;
      }

      const rawRow = slice[j];
      const fileRowNumber = startIdx + offset + j + 1;

      try {
        const mapped = extractMappedRowValues(rawRow, options.mapping);
        const parsedWord = parseInlineFurigana(mapped.word || '');
        const cleanWord = parsedWord.plainText.trim();

        if (!cleanWord) {
          result.failedRows.push({
            rowNumber: fileRowNumber,
            rawRow,
            word: '',
            reason: "Missing required 'word' field.",
          });
          continue;
        }

        const rawReading = (mapped.reading || parsedWord.reading || '').trim();
        const cleanMeaning = (mapped.meaning || '').trim();

        // Enforce meaning presence for meaning-based card types when meaning column is mapped
        const hasMeaningColumnMapped = options.mapping.includes('meaning');
        if (options.cardType !== 'reading' && hasMeaningColumnMapped && !cleanMeaning) {
          result.failedRows.push({
            rowNumber: fileRowNumber,
            rawRow,
            word: cleanWord,
            reason: "Missing 'meaning' value for selected card type.",
          });
          continue;
        }

        if (options.cardType === 'reading' && !rawReading && !parsedWord.reading) {
          // Reading card needs either explicit reading or tokenizer lookup; try tokenizer below
        }

        const cleanSentence = (mapped.sentence || '').replace(/<[^>]*>/g, '').trim();
        const enriched = await enrichCardFuriganaAndMetadata({
          word: cleanWord,
          reading: rawReading,
          sentence: cleanSentence,
          languageId: options.languageId,
          existingWordFurigana: parsedWord.segments,
          tokenizeFn: deps?.tokenizeFn,
        });

        const finalReading = enriched.reading.trim();
        const finalLemma = (enriched.lemma || cleanWord).trim();

        if (options.cardType === 'reading' && !finalReading) {
          result.failedRows.push({
            rowNumber: fileRowNumber,
            rawRow,
            word: cleanWord,
            reason: "Missing 'reading' value for Reading card.",
          });
          continue;
        }

        const rowDeckId = await getOrCreateRowDeckId(mapped.deck);
        const rowTags = parseTagsCell(mapped.tags || '');
        const cleanNotes = (mapped.notes || '').trim();
        const cleanLevel = (mapped.level || '').trim();

        const dupKey = `${finalLemma}\x1e${finalReading}\x1e${options.cardType}`;
        const existingDup = existingCardByKey.get(dupKey);

        if (existingDup && options.duplicateMode === 'skip') {
          result.skippedDuplicates += 1;
          continue;
        }

        const now = batchStartTime + j;

        if (existingDup && options.duplicateMode === 'update') {
          const mergedTags =
            rowTags.length > 0
              ? Array.from(new Set([...(existingDup.tags || []), ...rowTags]))
              : existingDup.tags || [];

          const updatedCard: CardItem = {
            ...existingDup,
            deckId: mapped.deck ? rowDeckId : existingDup.deckId,
            word: cleanWord,
            lemma: finalLemma,
            reading: finalReading,
            furiganaSegments: enriched.furiganaSegments ?? existingDup.furiganaSegments,
            meaning: cleanMeaning || existingDup.meaning,
            partOfSpeech: enriched.partOfSpeech || existingDup.partOfSpeech || '',
            level: cleanLevel || existingDup.level || '',
            sentence: cleanSentence || existingDup.sentence || '',
            sentenceFuriganaSegments:
              enriched.sentenceFuriganaSegments ?? existingDup.sentenceFuriganaSegments,
            tags: mergedTags,
            notes: cleanNotes || existingDup.notes || '',
            updatedAt: now,
          };

          toWrite.push(updatedCard);
          existingCardByKey.set(dupKey, updatedCard);
          result.cardsUpdated += 1;
          continue;
        }

        // Create new card initialized cleanly in New FSRS state
        const newCard: CardItem = {
          id: generateEntityId('card'),
          deckId: rowDeckId,
          languageId: options.languageId,
          cardType: options.cardType,
          word: cleanWord,
          lemma: finalLemma,
          reading: finalReading,
          furiganaSegments: enriched.furiganaSegments,
          meaning: cleanMeaning,
          partOfSpeech: enriched.partOfSpeech || '',
          level: cleanLevel,
          frequencyBand: '',
          sentence: cleanSentence,
          sentenceFuriganaSegments: enriched.sentenceFuriganaSegments,
          sourceDocTitle: '',
          tags: rowTags,
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
        if (!existingCardByKey.has(dupKey)) {
          existingCardByKey.set(dupKey, newCard);
        }
        result.cardsCreated += 1;
      } catch (rowErr: any) {
        result.failedRows.push({
          rowNumber: fileRowNumber,
          rawRow,
          word: (rawRow[options.mapping.indexOf('word')] || '').trim(),
          reason: rowErr?.message || 'Failed to process row.',
        });
      }
    }

    if (toWrite.length > 0) {
      await db.cards.bulkPut(toWrite);
    }

    const processed = Math.min(total, offset + slice.length);
    deps?.onProgress?.({
      processed,
      total,
      percent: Math.round((processed / total) * 100),
    });

    if (result.cancelled) break;
    await new Promise((r) => setTimeout(r, 0));
  }

  result.createdDeckNames = Array.from(new Set(createdDeckNames));

  if ((result.cardsCreated > 0 || result.cardsUpdated > 0) && !deps?.skipSideEffects) {
    invalidateStatsCache();
    await logEvent('cards_csv_imported', {
      languageId: options.languageId,
      rowsRead: result.rowsRead,
      cardsCreated: result.cardsCreated,
      cardsUpdated: result.cardsUpdated,
      skippedDuplicates: result.skippedDuplicates,
      errorsCount: result.failedRows.length,
    }).catch(() => {});
  }

  return result;
}

function escapeCsvCell(value: string, delimiter: ',' | '\t' = ','): string {
  const clean = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (clean.includes(delimiter) || clean.includes('"') || clean.includes('\n')) {
    return `"${clean.replace(/"/g, '""')}"`;
  }
  return clean;
}

/**
 * Generates a downloadable CSV report of all rows that failed during import.
 */
export function buildFailedRowsCsv(
  failedRows: FailedImportRow[],
  sourceHeaders?: string[]
): { fileName: string; bytes: Uint8Array; text: string } {
  const maxCols = Math.max(
    sourceHeaders?.length || 0,
    ...failedRows.map((f) => f.rawRow.length),
    1
  );
  const colHeaders = Array.from({ length: maxCols }, (_, idx) =>
    sourceHeaders && sourceHeaders[idx] ? sourceHeaders[idx] : `Column_${idx + 1}`
  );
  const headerLine = ['RowNumber', 'ErrorReason', ...colHeaders]
    .map((h) => escapeCsvCell(h, ','))
    .join(',');

  const lines = [headerLine];
  for (const fail of failedRows) {
    const padded = Array.from({ length: maxCols }, (_, idx) => fail.rawRow[idx] || '');
    const line = [String(fail.rowNumber), fail.reason, ...padded]
      .map((cell) => escapeCsvCell(cell, ','))
      .join(',');
    lines.push(line);
  }

  const text = `\uFEFF${lines.join('\n')}`;
  const bytes = new TextEncoder().encode(text);
  const dateStr = new Date().toISOString().slice(0, 10);
  return {
    fileName: `linguaforge-import-errors-${dateStr}.csv`,
    bytes,
    text,
  };
}
