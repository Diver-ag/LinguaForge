import {
  normalizeJlptLevel,
  inferLevelFromFileName,
  resolveRowJlptLevel,
  SINGLE_KANJI_REGEX,
} from '../packs/japanese/kanjiListParser';

export type BundledPackCategory =
  | 'core-dict'
  | 'common-dict'
  | 'examples'
  | 'kanji-levels'
  | 'frequency';

export const BUNDLED_PACK_CATEGORIES: BundledPackCategory[] = [
  'core-dict',
  'common-dict',
  'examples',
  'kanji-levels',
  'frequency',
];

export const BUNDLED_PACK_CATEGORY_LABELS: Record<BundledPackCategory, string> = {
  'core-dict': 'Core Dict',
  'common-dict': 'Common Dict',
  examples: 'Examples',
  'kanji-levels': 'Kanji Levels',
  frequency: 'Frequency',
};

export type TabularDelimiter = ',' | '\t' | ';';

export interface ParsedDelimitedTable {
  delimiter: TabularDelimiter;
  headers: string[];
  hasHeaderRow: boolean;
  rows: string[][];
}

export interface CategoryFieldDefinition {
  key: string;
  label: string;
  required?: boolean;
}

export interface CategoryMappingDetection {
  mapping: Record<string, number>;
  autoDetected: boolean;
  missingRequired: string[];
  availableFields: CategoryFieldDefinition[];
}

export const CATEGORY_FIELD_DEFINITIONS: Record<BundledPackCategory, CategoryFieldDefinition[]> = {
  'core-dict': [
    { key: 'word', label: 'Word / Term', required: true },
    { key: 'reading', label: 'Reading / Kana / Pinyin' },
    { key: 'meaning', label: 'Meaning / Gloss', required: true },
    { key: 'pos', label: 'Part of Speech' },
    { key: 'level', label: 'Level (JLPT / CEFR / HSK)' },
    { key: 'frequencyRank', label: 'Frequency Rank' },
  ],
  'common-dict': [
    { key: 'word', label: 'Word / Term', required: true },
    { key: 'reading', label: 'Reading / Kana / Pinyin' },
    { key: 'meaning', label: 'Meaning / Gloss', required: true },
    { key: 'pos', label: 'Part of Speech' },
    { key: 'level', label: 'Level (JLPT / CEFR / HSK)' },
    { key: 'frequencyRank', label: 'Frequency Rank' },
  ],
  examples: [
    { key: 'sentence', label: 'Target Sentence', required: true },
    { key: 'translation', label: 'English Translation', required: true },
    { key: 'word', label: 'Linked Word / Lemma' },
    { key: 'reading', label: 'Sentence Reading / Furigana' },
  ],
  'kanji-levels': [
    { key: 'character', label: 'Kanji Character', required: true },
    { key: 'level', label: 'JLPT Level' },
    { key: 'meaning', label: 'Meanings' },
    { key: 'onyomi', label: 'Onyomi' },
    { key: 'kunyomi', label: 'Kunyomi' },
    { key: 'reading', label: 'Combined Reading' },
    { key: 'strokes', label: 'Stroke Count' },
  ],
  frequency: [
    { key: 'word', label: 'Word / Term', required: true },
    { key: 'rank', label: 'Frequency Rank / Index' },
  ],
};

export interface ParsedDictCsvRow {
  word: string;
  readings: string[];
  meanings: string[];
  partsOfSpeech?: string[];
  level?: string;
  frequencyRank?: number;
}

export interface ParsedExampleCsvRow {
  sentence: string;
  translation: string;
  word?: string;
  reading?: string;
}

export interface ParsedKanjiCsvRow {
  character: string;
  jlptLevel: string;
  meanings: string[];
  onReadings: string[];
  kunReadings: string[];
  strokeCount?: number;
}

export interface ParsedFrequencyCsvRow {
  word: string;
  rank: number;
  form?: string;
}

export function stripUtf8Bom(text: string): string {
  return text.replace(/^\uFEFF/, '');
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

function countFieldsInLine(line: string, delimiter: TabularDelimiter): number {
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
 * Detects delimiter purely from file content (comma, tab, semicolon),
 * preferring delimiters that split the header/sample lines into consistent >=2 columns.
 */
export function detectTabularDelimiter(text: string, _fileName = ''): TabularDelimiter {
  const sampleLines = splitSampleLines(stripUtf8Bom(text), 12);
  if (sampleLines.length === 0) return ',';

  const candidates: TabularDelimiter[] = ['\t', ',', ';'];
  let bestDelim: TabularDelimiter = ',';
  let bestScore = -1;

  const firstCounts = {
    '\t': countFieldsInLine(sampleLines[0], '\t'),
    ',': countFieldsInLine(sampleLines[0], ','),
    ';': countFieldsInLine(sampleLines[0], ';'),
  };

  for (const delim of candidates) {
    const headerFields = firstCounts[delim];
    if (headerFields <= 1 && sampleLines.every((l) => countFieldsInLine(l, delim) <= 1)) {
      continue;
    }

    let consistentLines = 0;
    let multiFieldLines = 0;
    let totalFields = 0;

    for (const line of sampleLines) {
      const cnt = countFieldsInLine(line, delim);
      if (cnt > 1) multiFieldLines++;
      if (cnt > 1 && cnt === headerFields) consistentLines++;
      totalFields += cnt;
    }

    // Strongly reward matching the first line's column count across rows (prevents ';' inside quoted/unquoted glosses beating ',')
    const score =
      consistentLines * 100 +
      multiFieldLines * 10 +
      (headerFields > 1 ? headerFields * 3 : 0) +
      totalFields * 0.1 +
      (delim === '\t' ? 0.05 : 0);

    if (score > bestScore) {
      bestScore = score;
      bestDelim = delim;
    }
  }

  return bestDelim;
}

/**
 * RFC-4180 compliant quote-aware CSV/TSV/SSV parser.
 * Handles delimiters inside quotes, escaped quotes (""), UTF-8 BOM, CRLF/LF/CR, and multiline quoted cells.
 */
export function parseRfcDelimitedText(
  rawText: string,
  delimiter?: TabularDelimiter,
  fileName = '',
  maxRows?: number
): string[][] {
  const cleanText = stripUtf8Bom(rawText);
  if (!cleanText.trim()) return [];

  const delim = delimiter || detectTabularDelimiter(cleanText, fileName);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let startedQuoted = false;

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

    if (ch === '"' && field.length === 0 && !startedQuoted) {
      inQuotes = true;
      startedQuoted = true;
      continue;
    }

    if (ch === delim) {
      row.push(field.trim().normalize('NFC'));
      field = '';
      startedQuoted = false;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && cleanText[i + 1] === '\n') {
        i++;
      }
      row.push(field.trim().normalize('NFC'));
      field = '';
      startedQuoted = false;
      if (row.some((c) => c !== '')) {
        rows.push(row);
        if (maxRows !== undefined && rows.length >= maxRows) {
          return rows;
        }
      }
      row = [];
      continue;
    }

    field += ch;
  }

  row.push(field.trim().normalize('NFC'));
  if (row.some((c) => c !== '')) {
    rows.push(row);
  }

  return rows;
}

const ALL_KNOWN_PACK_HEADERS = new Set([
  'word',
  'term',
  'expression',
  'kanji',
  'headword',
  'lemma',
  'vocab-kanji',
  'vocab',
  'vocabulary',
  'reading',
  'readings',
  'kana',
  'pinyin',
  'pronunciation',
  'ipa',
  'yomi',
  'meaning',
  'meanings',
  'definition',
  'definitions',
  'gloss',
  'glosses',
  'english',
  'pos',
  'partofspeech',
  'part_of_speech',
  'level',
  'jlpt',
  'jlpt_level',
  'cefr',
  'hsk',
  'topik',
  'lvl',
  'sentence',
  'target',
  'text',
  'japanese',
  'original',
  'example',
  'translation',
  'translated',
  'character',
  'char',
  'onyomi',
  'on',
  'on_yomi',
  'kunyomi',
  'kun',
  'kun_yomi',
  'stroke',
  'strokes',
  'stroke_count',
  'rank',
  'frequency',
  'freq',
  'frequencyrank',
  'frequency_rank',
  'index',
  'w',
  'r',
  'm',
  'p',
  'f',
]);

function normalizeHeaderToken(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function isLikelyPackHeaderRow(firstRow: string[], category?: BundledPackCategory): boolean {
  if (
    category === 'kanji-levels' &&
    firstRow.some((cell) => SINGLE_KANJI_REGEX.test(cell.normalize('NFC').trim()))
  ) {
    return false;
  }
  const normalized = firstRow.map(normalizeHeaderToken);
  return normalized.some((cell) => ALL_KNOWN_PACK_HEADERS.has(cell));
}

export function parseDelimitedPackTable(
  rawText: string,
  fileName = '',
  category?: BundledPackCategory,
  maxDataRows?: number
): ParsedDelimitedTable {
  const cleanText = stripUtf8Bom(rawText);
  const delimiter = detectTabularDelimiter(cleanText, fileName);
  const parsed = parseRfcDelimitedText(
    cleanText,
    delimiter,
    fileName,
    maxDataRows !== undefined ? maxDataRows + 1 : undefined
  );

  if (parsed.length === 0) {
    return {
      delimiter,
      headers: [],
      hasHeaderRow: false,
      rows: [],
    };
  }

  const hasHeaderRow = isLikelyPackHeaderRow(parsed[0], category);
  const dataRows = hasHeaderRow ? parsed.slice(1) : parsed;
  const maxCols = Math.max(
    parsed[0].length,
    ...dataRows.slice(0, 50).map((r) => r.length)
  );

  const headers = hasHeaderRow
    ? Array.from({ length: maxCols }, (_, i) => parsed[0][i]?.trim() || `Column ${i + 1}`)
    : Array.from({ length: maxCols }, (_, i) => `Column ${i + 1}`);

  const rows = dataRows.map((r) => {
    if (r.length === maxCols) return r;
    const copy = [...r];
    while (copy.length < maxCols) copy.push('');
    return copy;
  });

  return {
    delimiter,
    headers,
    hasHeaderRow,
    rows,
  };
}

function findHeaderIndex(
  normHeaders: string[],
  exactAliases: string[],
  exclude = new Set<number>()
): number {
  for (const alias of exactAliases) {
    const idx = normHeaders.findIndex((h, i) => !exclude.has(i) && h === alias);
    if (idx !== -1) return idx;
  }
  for (const alias of exactAliases) {
    if (alias.length < 3) continue;
    const idx = normHeaders.findIndex((h, i) => !exclude.has(i) && h.includes(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

export function detectCategoryColumnMapping(
  category: BundledPackCategory,
  table: ParsedDelimitedTable
): CategoryMappingDetection {
  const normHeaders = table.headers.map(normalizeHeaderToken);
  const availableFields = CATEGORY_FIELD_DEFINITIONS[category];
  const used = new Set<number>();
  const mapping: Record<string, number> = {};

  if (category === 'core-dict' || category === 'common-dict') {
    const wordIdx = findHeaderIndex(
      normHeaders,
      ['word', 'term', 'expression', 'kanji', 'headword', 'lemma', 'vocab-kanji', 'vocab', 'vocabulary', 'w'],
      used
    );
    if (wordIdx !== -1) used.add(wordIdx);

    const meaningIdx = findHeaderIndex(
      normHeaders,
      ['meaning', 'meanings', 'definition', 'definitions', 'gloss', 'glosses', 'english', 'translation', 'm'],
      used
    );
    if (meaningIdx !== -1) used.add(meaningIdx);

    const readingIdx = findHeaderIndex(
      normHeaders,
      ['reading', 'readings', 'kana', 'pinyin', 'pronunciation', 'ipa', 'r'],
      used
    );
    if (readingIdx !== -1) used.add(readingIdx);

    const posIdx = findHeaderIndex(
      normHeaders,
      ['pos', 'partofspeech', 'part_of_speech', 'parts_of_speech', 'type', 'p'],
      used
    );
    if (posIdx !== -1) used.add(posIdx);

    const levelIdx = findHeaderIndex(
      normHeaders,
      ['level', 'jlpt', 'cefr', 'hsk', 'topik', 'lvl', 'grade'],
      used
    );
    if (levelIdx !== -1) used.add(levelIdx);

    const freqIdx = findHeaderIndex(
      normHeaders,
      ['frequencyrank', 'frequency_rank', 'rank', 'frequency', 'freq', 'index', 'f'],
      used
    );
    if (freqIdx !== -1) used.add(freqIdx);

    mapping.word = wordIdx;
    mapping.reading = readingIdx;
    mapping.meaning = meaningIdx;
    mapping.pos = posIdx;
    mapping.level = levelIdx;
    mapping.frequencyRank = freqIdx;

    const autoDetected = table.hasHeaderRow && wordIdx !== -1 && meaningIdx !== -1;
    const missingRequired: string[] = [];
    if (wordIdx === -1) missingRequired.push('word');
    if (meaningIdx === -1) missingRequired.push('meaning');

    return { mapping, autoDetected, missingRequired, availableFields };
  }

  if (category === 'examples') {
    const sentenceIdx = findHeaderIndex(
      normHeaders,
      ['sentence', 'target', 'text', 'japanese', 'original', 'example', 'source', 'target_sentence'],
      used
    );
    if (sentenceIdx !== -1) used.add(sentenceIdx);

    const translationIdx = findHeaderIndex(
      normHeaders,
      ['translation', 'english', 'meaning', 'gloss', 'translated', 'en'],
      used
    );
    if (translationIdx !== -1) used.add(translationIdx);

    const wordIdx = findHeaderIndex(
      normHeaders,
      ['word', 'lemma', 'term', 'headword', 'expression', 'vocab'],
      used
    );
    if (wordIdx !== -1) used.add(wordIdx);

    const readingIdx = findHeaderIndex(
      normHeaders,
      ['reading', 'kana', 'pinyin', 'furigana'],
      used
    );
    if (readingIdx !== -1) used.add(readingIdx);

    mapping.sentence = sentenceIdx;
    mapping.translation = translationIdx;
    mapping.word = wordIdx;
    mapping.reading = readingIdx;

    const autoDetected = table.hasHeaderRow && sentenceIdx !== -1 && translationIdx !== -1;
    const missingRequired: string[] = [];
    if (sentenceIdx === -1) missingRequired.push('sentence');
    if (translationIdx === -1) missingRequired.push('translation');

    return { mapping, autoDetected, missingRequired, availableFields };
  }

  if (category === 'kanji-levels') {
    const charIdx = findHeaderIndex(
      normHeaders,
      ['kanji', 'character', 'char', 'glyph', 'symbol'],
      used
    );
    if (charIdx !== -1) used.add(charIdx);

    const levelIdx = findHeaderIndex(
      normHeaders,
      ['jlpt', 'level', 'jlpt_level', 'jlptlevel', 'lvl'],
      used
    );
    if (levelIdx !== -1) used.add(levelIdx);

    const meaningIdx = findHeaderIndex(
      normHeaders,
      ['meaning', 'meanings', 'gloss', 'glosses', 'english', 'definition'],
      used
    );
    if (meaningIdx !== -1) used.add(meaningIdx);

    const onIdx = findHeaderIndex(
      normHeaders,
      ['onyomi', 'on', 'on_yomi', 'on-yomi', '音', '音読み'],
      used
    );
    if (onIdx !== -1) used.add(onIdx);

    const kunIdx = findHeaderIndex(
      normHeaders,
      ['kunyomi', 'kun', 'kun_yomi', 'kun-yomi', '訓', '訓読み'],
      used
    );
    if (kunIdx !== -1) used.add(kunIdx);

    const readingIdx = findHeaderIndex(
      normHeaders,
      ['reading', 'readings', 'kana', 'yomi'],
      used
    );
    if (readingIdx !== -1) used.add(readingIdx);

    const strokeIdx = findHeaderIndex(
      normHeaders,
      ['strokes', 'stroke', 'stroke_count', 'strokecount'],
      used
    );
    if (strokeIdx !== -1) used.add(strokeIdx);

    mapping.character = charIdx;
    mapping.level = levelIdx;
    mapping.meaning = meaningIdx;
    mapping.onyomi = onIdx;
    mapping.kunyomi = kunIdx;
    mapping.reading = readingIdx;
    mapping.strokes = strokeIdx;

    const autoDetected = table.hasHeaderRow && charIdx !== -1;
    const missingRequired: string[] = [];
    if (charIdx === -1) missingRequired.push('character');

    return { mapping, autoDetected, missingRequired, availableFields };
  }

  // frequency
  const wordIdx = findHeaderIndex(
    normHeaders,
    ['word', 'term', 'expression', 'kanji', 'headword', 'lemma', 'w'],
    used
  );
  if (wordIdx !== -1) used.add(wordIdx);

  const rankIdx = findHeaderIndex(
    normHeaders,
    ['rank', 'frequency', 'freq', 'index', 'frequencyrank', 'frequency_rank', 'f'],
    used
  );
  if (rankIdx !== -1) used.add(rankIdx);

  const formIdx = findHeaderIndex(
    normHeaders,
    ['form', 'reading', 'kana', 'surface'],
    used
  );
  if (formIdx !== -1) used.add(formIdx);

  mapping.word = wordIdx;
  mapping.rank = rankIdx;
  if (formIdx !== -1) mapping.form = formIdx;

  const autoDetected =
    table.hasHeaderRow &&
    wordIdx !== -1 &&
    (rankIdx !== -1 || table.headers.length === 1);
  const missingRequired: string[] = [];
  if (wordIdx === -1) missingRequired.push('word');

  return { mapping, autoDetected, missingRequired, availableFields };
}

export function extractDictRowsFromTable(
  table: ParsedDelimitedTable,
  mapping?: Record<string, number>
): ParsedDictCsvRow[] {
  const detected = mapping || detectCategoryColumnMapping('common-dict', table).mapping;
  const wordCol = detected.word !== undefined && detected.word >= 0 ? detected.word : 0;
  const meaningCol =
    detected.meaning !== undefined && detected.meaning >= 0
      ? detected.meaning
      : table.headers.length >= 2 && detected.reading !== 1
      ? 1
      : table.headers.length >= 3
      ? 2
      : -1;
  const readingCol = detected.reading !== undefined ? detected.reading : -1;
  const posCol = detected.pos !== undefined ? detected.pos : -1;
  const levelCol = detected.level !== undefined ? detected.level : -1;
  const freqCol = detected.frequencyRank !== undefined ? detected.frequencyRank : -1;

  const out: ParsedDictCsvRow[] = [];
  for (const row of table.rows) {
    const word = (row[wordCol] || '').trim();
    if (!word) continue;

    const rawMeaning = meaningCol >= 0 ? row[meaningCol] || '' : '';
    const meanings = rawMeaning
      ? rawMeaning
          .split(/[;|]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (meanings.length === 0) continue;

    const rawReading = readingCol >= 0 ? row[readingCol] || '' : '';
    const readings = rawReading
      ? rawReading
          .split(/[;|]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const rawPos = posCol >= 0 ? row[posCol] || '' : '';
    const partsOfSpeech = rawPos
      ? rawPos
          .split(/[,;|]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const level = levelCol >= 0 ? (row[levelCol] || '').trim() || undefined : undefined;
    const rawFreq = freqCol >= 0 ? row[freqCol] || '' : '';
    const parsedFreq = parseInt(rawFreq.replace(/[^0-9]/g, ''), 10);
    const frequencyRank = Number.isFinite(parsedFreq) && parsedFreq > 0 ? parsedFreq : undefined;

    out.push({
      word,
      readings,
      meanings,
      partsOfSpeech,
      level,
      frequencyRank,
    });
  }
  return out;
}

export function extractExampleRowsFromTable(
  table: ParsedDelimitedTable,
  mapping?: Record<string, number>
): ParsedExampleCsvRow[] {
  const detected = mapping || detectCategoryColumnMapping('examples', table).mapping;
  const sentenceCol = detected.sentence !== undefined && detected.sentence >= 0 ? detected.sentence : 0;
  const translationCol =
    detected.translation !== undefined && detected.translation >= 0
      ? detected.translation
      : table.headers.length >= 2
      ? 1
      : -1;
  const wordCol = detected.word !== undefined ? detected.word : -1;
  const readingCol = detected.reading !== undefined ? detected.reading : -1;

  const out: ParsedExampleCsvRow[] = [];
  for (const row of table.rows) {
    const sentence = (row[sentenceCol] || '').trim();
    const translation = translationCol >= 0 ? (row[translationCol] || '').trim() : '';
    if (!sentence || !translation) continue;
    const word = wordCol >= 0 ? (row[wordCol] || '').trim() || undefined : undefined;
    const reading = readingCol >= 0 ? (row[readingCol] || '').trim() || undefined : undefined;
    out.push({ sentence, translation, word, reading });
  }
  return out;
}

export function extractKanjiRowsFromTable(
  table: ParsedDelimitedTable,
  fileName: string,
  mapping?: Record<string, number>
): ParsedKanjiCsvRow[] {
  const detected = mapping || detectCategoryColumnMapping('kanji-levels', table).mapping;
  const inferredLevel = inferLevelFromFileName(fileName);

  const charCol = detected.character !== undefined && detected.character >= 0 ? detected.character : 0;
  const levelCol = detected.level !== undefined ? detected.level : -1;
  const meaningCol = detected.meaning !== undefined ? detected.meaning : -1;
  const onCol = detected.onyomi !== undefined ? detected.onyomi : -1;
  const kunCol = detected.kunyomi !== undefined ? detected.kunyomi : -1;
  const readingCol = detected.reading !== undefined ? detected.reading : -1;
  const strokeCol = detected.strokes !== undefined ? detected.strokes : -1;

  const out: ParsedKanjiCsvRow[] = [];
  for (const row of table.rows) {
    const rawChar = (row[charCol] || '').normalize('NFC').trim();
    if (!rawChar || !SINGLE_KANJI_REGEX.test(rawChar)) continue;

    const rawLvl = levelCol >= 0 ? row[levelCol] || '' : '';
    const jlptLevel = resolveRowJlptLevel(rawLvl, inferredLevel);

    const meanings =
      meaningCol >= 0 && row[meaningCol]
        ? row[meaningCol]
            .split(/[,;/|]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

    const onReadings: string[] = [];
    const kunReadings: string[] = [];

    if (onCol >= 0 && row[onCol]) {
      onReadings.push(
        ...row[onCol]
          .split(/[,;/、\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      );
    }
    if (kunCol >= 0 && row[kunCol]) {
      kunReadings.push(
        ...row[kunCol]
          .split(/[,;/、\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      );
    }
    if (readingCol >= 0 && row[readingCol] && onReadings.length === 0 && kunReadings.length === 0) {
      const parts = row[readingCol]
        .split(/[,;/、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const r of parts) {
        if (/[\u30a0-\u30ff]/.test(r)) onReadings.push(r);
        else kunReadings.push(r);
      }
    }

    let strokeCount: number | undefined;
    if (strokeCol >= 0 && row[strokeCol]) {
      const parsedStroke = parseInt(row[strokeCol].replace(/\D/g, ''), 10);
      if (!isNaN(parsedStroke) && parsedStroke > 0) strokeCount = parsedStroke;
    }

    out.push({
      character: rawChar,
      jlptLevel,
      meanings,
      onReadings,
      kunReadings,
      strokeCount,
    });
  }

  return out;
}

export function extractFrequencyRowsFromTable(
  table: ParsedDelimitedTable,
  mapping?: Record<string, number>
): ParsedFrequencyCsvRow[] {
  const detected = mapping || detectCategoryColumnMapping('frequency', table).mapping;
  const wordCol = detected.word !== undefined && detected.word >= 0 ? detected.word : 0;
  const formCol = detected.form !== undefined && detected.form >= 0 ? detected.form : -1;
  const rankCol =
    detected.rank !== undefined && detected.rank >= 0
      ? detected.rank
      : table.headers.length >= 2
      ? 1
      : -1;

  const out: ParsedFrequencyCsvRow[] = [];
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    const word = (row[wordCol] || '').trim();
    if (!word) continue;

    const form = formCol >= 0 ? (row[formCol] || '').trim() || undefined : undefined;

    let rank = i + 1;
    if (rankCol >= 0) {
      const parsed = parseInt((row[rankCol] || '').replace(/[^0-9]/g, ''), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        rank = parsed;
      } else if (table.headers.length >= 2) {
        continue;
      }
    }

    const item: ParsedFrequencyCsvRow = { word, rank };
    if (form && form !== word) {
      item.form = form;
    }
    out.push(item);
  }
  return out;
}

export { normalizeJlptLevel };
