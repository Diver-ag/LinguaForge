export const SINGLE_KANJI_REGEX = /^[\u4e00-\u9faf\u3400-\u4dbf々〆〇]$/;

export type KanjiFileFormat = 'csv' | 'tsv' | 'json-map' | 'json-array';

export interface KanjiColumnMapping {
  charCol: number;
  levelCol: number;
  readingCol: number;
  onCol: number;
  kunCol: number;
  meaningCol: number;
  strokeCol: number;
}

export interface ParsedKanjiTable {
  fileName: string;
  format: KanjiFileFormat;
  headers: string[];
  hasHeaderRow: boolean;
  rows: string[][];
  inferredLevel: string | null;
  detectedMapping: KanjiColumnMapping;
}

export interface NormalizedKanjiPreviewRow {
  rowIndex: number;
  rawRow: string[];
  character: string;
  jlptLevel: string;
  status: 'valid' | 'skipped' | 'ignored-level';
  statusReason?: string;
}

/**
 * Normalizes JLPT level strings/numbers:
 * Accepts N5, n5, 5, "level 5", "JLPT N5", "jlpt 5", etc. (5 = N5 easiest, 1 = N1 hardest).
 * Strictly ignores values outside 1-5 (e.g. 0, 6, N6, level 6, grade 6 -> returns null).
 */
export function normalizeJlptLevel(raw: unknown): 'N5' | 'N4' | 'N3' | 'N2' | 'N1' | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw >= 1 && raw <= 5) {
      return `N${raw}` as 'N5' | 'N4' | 'N3' | 'N2' | 'N1';
    }
    return null;
  }

  const str = String(raw).normalize('NFC').trim();
  if (!str) return null;

  // Match "5", "N5", "n5", "N-5", "level 5", "level5", "lvl 5", "jlpt 5", "jlpt n5", etc.
  const match = str.match(
    /^(?:(?:jlpt|level|lvl|jlpt\s*level)\s*[-_:]?\s*)?n?\s*[-_:]?\s*([1-5])$/i
  );
  if (match && match[1]) {
    return `N${match[1]}` as 'N5' | 'N4' | 'N3' | 'N2' | 'N1';
  }

  return null;
}

/**
 * Infers a JLPT level (N1-N5) from a filename when the file itself has no level column.
 * Examples: "kanji-n5.csv", "n5_kanji.csv", "jlpt5.json", "level_4.tsv"
 */
export function inferLevelFromFileName(fileName: string): 'N5' | 'N4' | 'N3' | 'N2' | 'N1' | null {
  const lower = fileName.toLowerCase();

  // Match boundaries like kanji-n5.csv, n5_kanji.csv, jlpt5, level-5, etc. (avoid n10 matching n1)
  const patterns = [
    /(?:^|[^a-z0-9])n([1-5])(?:[^0-9]|$)/i,
    /(?:jlpt|level|lvl)[-_ ]?n?([1-5])(?:[^0-9]|$)/i,
    /^n([1-5])/i,
  ];

  for (const re of patterns) {
    const m = lower.match(re);
    if (m && m[1]) {
      return `N${m[1]}` as 'N5' | 'N4' | 'N3' | 'N2' | 'N1';
    }
  }

  return null;
}

/**
 * Resolves final level string for a row.
 * - If rawLvl is provided and non-empty: normalize it; values outside 1-5 are ignored ('No level').
 * - If rawLvl is empty/absent: fall back to inferredLevel (from filename) if present, else 'No level'.
 */
export function resolveRowJlptLevel(rawLvl: unknown, inferredLevel: string | null): string {
  const str = rawLvl === null || rawLvl === undefined ? '' : String(rawLvl).trim();
  if (str !== '') {
    return normalizeJlptLevel(rawLvl) || 'No level';
  }
  if (inferredLevel && /^N[1-5]$/.test(inferredLevel)) {
    return inferredLevel;
  }
  return 'No level';
}

export function isEasierLevel(candidateLevel: string, existingLevel: string): boolean {
  const cNum = parseInt(candidateLevel.replace(/\D/g, ''), 10);
  const eNum = parseInt(existingLevel.replace(/\D/g, ''), 10);
  if (!cNum || isNaN(cNum) || cNum < 1 || cNum > 5) return false;
  if (!eNum || isNaN(eNum) || eNum < 1 || eNum > 5) return true;
  // N5 (5) > N4 (4) -> higher number is easier
  return cNum > eNum;
}

function detectDelimiter(lines: string[], fileName: string): ',' | '\t' {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tsv')) return '\t';

  const sample = lines.slice(0, 10);
  let tabLines = 0;
  let commaLines = 0;
  for (const line of sample) {
    const tabs = (line.match(/\t/g) || []).length;
    const commas = (line.match(/,/g) || []).length;
    if (tabs > 0 && tabs >= commas) tabLines++;
    else if (commas > 0) commaLines++;
  }
  return tabLines > commaLines ? '\t' : ',';
}

function splitDelimitedLine(line: string, delimiter: ',' | '\t'): string[] {
  const row: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      row.push(cur.trim().replace(/^["']|["']$/g, '').normalize('NFC'));
      cur = '';
    } else {
      cur += ch;
    }
  }
  row.push(cur.trim().replace(/^["']|["']$/g, '').normalize('NFC'));
  return row;
}

const KNOWN_HEADER_KEYWORDS = new Set([
  'expression',
  'word',
  'kanji',
  'character',
  'char',
  'reading',
  'readings',
  'kana',
  'yomi',
  'level',
  'jlpt',
  'jlpt_level',
  'jlptlevel',
  'lvl',
  'grade',
  'rank',
  'frequency',
  'on',
  'onyomi',
  'on_yomi',
  'kun',
  'kunyomi',
  'kun_yomi',
  'meaning',
  'meanings',
  'definition',
  'definitions',
  'english',
  'gloss',
  'stroke',
  'strokes',
  'stroke_count',
  'strokecount',
  'id',
]);

function isLikelyHeaderRow(firstRow: string[]): boolean {
  // If any cell in the first row is already a single kanji character, it is a data row
  if (firstRow.some((cell) => SINGLE_KANJI_REGEX.test(cell.normalize('NFC').trim()))) {
    return false;
  }

  const lowerCells = firstRow.map((s) => s.toLowerCase().trim().replace(/^\uFEFF/, ''));
  return lowerCells.some(
    (s) =>
      KNOWN_HEADER_KEYWORDS.has(s) ||
      s.includes('kanji') ||
      s.includes('char') ||
      s.includes('jlpt') ||
      s.includes('level') ||
      s.includes('reading') ||
      s.includes('meaning') ||
      s.includes('stroke')
  );
}

function formatJsonValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) {
    return val.map((v) => String(v).trim()).filter(Boolean).join('; ');
  }
  if (typeof val === 'object') {
    return JSON.stringify(val);
  }
  return String(val).normalize('NFC').trim();
}

/**
 * Auto-detects column roles using both actual cell contents (e.g. single-character kanji column)
 * and header names.
 */
export function detectKanjiColumns(headers: string[], rows: string[][]): KanjiColumnMapping {
  const lowerHeaders = headers.map((h) => h.toLowerCase().trim());
  const colCount = Math.max(headers.length, rows[0]?.length || 0);
  const sampleRows = rows.slice(0, 25);

  // 1. Detect Kanji column automatically: look for a single-character kanji field first
  let charCol = -1;
  let bestKanjiScore = 0;

  for (let c = 0; c < colCount; c++) {
    let kanjiMatches = 0;
    let nonEmpty = 0;
    for (const r of sampleRows) {
      const val = (r[c] || '').normalize('NFC').trim();
      if (!val) continue;
      nonEmpty++;
      if (SINGLE_KANJI_REGEX.test(val)) {
        kanjiMatches++;
      }
    }
    if (nonEmpty > 0 && kanjiMatches > 0) {
      // Favor columns where single-kanji ratio is high
      const score = kanjiMatches * 10 + kanjiMatches / nonEmpty;
      if (score > bestKanjiScore) {
        bestKanjiScore = score;
        charCol = c;
      }
    }
  }

  // Fallback or tie-breaker by header name if data didn't unambiguously show kanji
  if (charCol === -1) {
    charCol = lowerHeaders.findIndex(
      (h) =>
        h === 'kanji' ||
        h === 'character' ||
        h === 'char' ||
        h.includes('kanji') ||
        h.includes('character') ||
        h.includes('char') ||
        h === 'word' ||
        h === 'expression'
    );
  }
  if (charCol === -1 && colCount > 0) {
    charCol = 0;
  }

  // 2. Detect JLPT level column
  let levelCol = lowerHeaders.findIndex(
    (h, idx) =>
      idx !== charCol &&
      (h === 'jlpt' ||
        h === 'level' ||
        h === 'lvl' ||
        h.includes('jlpt') ||
        h.includes('level'))
  );

  const NON_LEVEL_HEADERS = new Set([
    'id',
    'index',
    'no',
    'num',
    'number',
    'stroke',
    'strokes',
    'stroke_count',
    'strokecount',
    'grade',
    'rank',
    'freq',
    'frequency',
    'radical',
    'radicals',
  ]);

  if (levelCol === -1 && sampleRows.length > 0) {
    let bestLvlScore = 0;
    for (let c = 0; c < colCount; c++) {
      if (c === charCol) continue;
      const h = lowerHeaders[c] || '';
      if (NON_LEVEL_HEADERS.has(h) || h.includes('stroke') || h.includes('rank') || h.includes('freq')) {
        continue;
      }
      let validLevels = 0;
      let nonEmpty = 0;
      for (const r of sampleRows) {
        const val = (r[c] || '').trim();
        if (!val) continue;
        nonEmpty++;
        if (normalizeJlptLevel(val) !== null) {
          validLevels++;
        }
      }
      if (nonEmpty > 0 && validLevels > 0 && validLevels / nonEmpty >= 0.5) {
        if (validLevels > bestLvlScore) {
          bestLvlScore = validLevels;
          levelCol = c;
        }
      }
    }
  }

  // 3. Detect on-yomi, kun-yomi, readings, meanings, strokes (strictly avoiding substring bugs like 'definition'.includes('on'))
  const onCol = lowerHeaders.findIndex(
    (h, idx) =>
      idx !== charCol &&
      idx !== levelCol &&
      (/^(on|on[-_ ]?yomi|onyomi|音|音読み)$/.test(h) || h.includes('onyomi'))
  );

  const kunCol = lowerHeaders.findIndex(
    (h, idx) =>
      idx !== charCol &&
      idx !== levelCol &&
      idx !== onCol &&
      (/^(kun|kun[-_ ]?yomi|kunyomi|訓|訓読み)$/.test(h) || h.includes('kunyomi'))
  );

  const readingCol = lowerHeaders.findIndex(
    (h, idx) =>
      idx !== charCol &&
      idx !== levelCol &&
      idx !== onCol &&
      idx !== kunCol &&
      (h.includes('reading') || h.includes('kana') || h.includes('yomi'))
  );

  const meaningCol = lowerHeaders.findIndex(
    (h, idx) =>
      idx !== charCol &&
      idx !== levelCol &&
      idx !== onCol &&
      idx !== kunCol &&
      idx !== readingCol &&
      (h.includes('mean') ||
        h.includes('definition') ||
        h.includes('english') ||
        h.includes('gloss'))
  );

  const strokeCol = lowerHeaders.findIndex(
    (h, idx) =>
      idx !== charCol &&
      idx !== levelCol &&
      idx !== onCol &&
      idx !== kunCol &&
      idx !== readingCol &&
      idx !== meaningCol &&
      h.includes('stroke')
  );

  return {
    charCol,
    levelCol,
    readingCol,
    onCol,
    kunCol,
    meaningCol,
    strokeCol,
  };
}

/**
 * Parses CSV, TSV, or JSON (both {"気": 5} object map and array of objects) into a unified table
 * with auto-detected column mappings and filename-inferred level.
 */
export function parseKanjiListTable(rawText: string, fileName: string): ParsedKanjiTable {
  const cleanText = rawText.replace(/^\uFEFF/, '');
  const trimmed = cleanText.trim();
  const inferredLevel = inferLevelFromFileName(fileName);

  // Attempt JSON parsing if file is .json or starts with { / [
  const looksLikeJson =
    fileName.toLowerCase().endsWith('.json') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');

  if (looksLikeJson && trimmed.length > 0) {
    try {
      const parsed = JSON.parse(trimmed);

      // Case 1: Array (of objects, strings, or arrays)
      if (Array.isArray(parsed)) {
        return buildTableFromJsonArray(parsed, fileName, inferredLevel);
      }

      // Case 2: Object
      if (parsed && typeof parsed === 'object') {
        // Check if it's a wrapper object containing an array field (e.g. { kanji: [...] }, { entries: [...] })
        const wrapperArrayKey = ['kanji', 'entries', 'items', 'data', 'rows', 'words', 'list'].find(
          (k) => Array.isArray(parsed[k])
        );
        if (wrapperArrayKey) {
          return buildTableFromJsonArray(parsed[wrapperArrayKey], fileName, inferredLevel);
        }

        // Direct object map: e.g. {"気": 5, "学": "N5"} or {"気": {"jlpt": 5, "meanings": [...]}}
        const entries = Object.entries(parsed);
        const firstVal = entries[0]?.[1];

        if (firstVal && typeof firstVal === 'object' && !Array.isArray(firstVal)) {
          // Object of character -> detail object
          const keySet = new Set<string>(['character']);
          for (const [, val] of entries.slice(0, 25)) {
            if (val && typeof val === 'object' && !Array.isArray(val)) {
              for (const k of Object.keys(val)) keySet.add(k);
            }
          }
          const headers = Array.from(keySet);
          const rows = entries.map(([charKey, val]) => {
            const obj = (val && typeof val === 'object' ? val : {}) as Record<string, unknown>;
            return headers.map((h, i) => (i === 0 ? charKey.normalize('NFC').trim() : formatJsonValue(obj[h])));
          });
          return {
            fileName,
            format: 'json-map',
            headers,
            hasHeaderRow: true,
            rows,
            inferredLevel,
            detectedMapping: detectKanjiColumns(headers, rows),
          };
        }

        // Standard key->value map {"気": 5}
        const headers = ['character', 'level'];
        const rows = entries.map(([charKey, val]) => [
          charKey.normalize('NFC').trim(),
          val === null || val === undefined ? '' : String(val).normalize('NFC').trim(),
        ]);
        return {
          fileName,
          format: 'json-map',
          headers,
          hasHeaderRow: true,
          rows,
          inferredLevel,
          detectedMapping: detectKanjiColumns(headers, rows),
        };
      }
    } catch {
      // Fall through to CSV/TSV parser if JSON.parse fails
    }
  }

  // Case 3: CSV or TSV
  const rawLines = cleanText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dataLines = rawLines.filter((l) => !l.startsWith('#') && !l.startsWith('//'));
  const delimiter = detectDelimiter(dataLines, fileName);
  const format: KanjiFileFormat = delimiter === '\t' ? 'tsv' : 'csv';

  if (dataLines.length === 0) {
    return {
      fileName,
      format,
      headers: [],
      hasHeaderRow: false,
      rows: [],
      inferredLevel,
      detectedMapping: {
        charCol: 0,
        levelCol: -1,
        readingCol: -1,
        onCol: -1,
        kunCol: -1,
        meaningCol: -1,
        strokeCol: -1,
      },
    };
  }

  const parsedLines = dataLines
    .map((line) => splitDelimitedLine(line, delimiter))
    .filter((row) => row.some(Boolean));

  if (parsedLines.length === 0) {
    return {
      fileName,
      format,
      headers: [],
      hasHeaderRow: false,
      rows: [],
      inferredLevel,
      detectedMapping: {
        charCol: 0,
        levelCol: -1,
        readingCol: -1,
        onCol: -1,
        kunCol: -1,
        meaningCol: -1,
        strokeCol: -1,
      },
    };
  }

  const hasHeaderRow = isLikelyHeaderRow(parsedLines[0]);
  const rawRows = hasHeaderRow ? parsedLines.slice(1) : parsedLines;
  const maxCols = Math.max(
    parsedLines[0].length,
    ...rawRows.slice(0, 20).map((r) => r.length)
  );

  const headers = hasHeaderRow
    ? parsedLines[0].map((h, i) => h.trim() || `Column ${i + 1}`)
    : Array.from({ length: maxCols }, (_, i) => `Column ${i + 1}`);

  // Normalize row lengths to maxCols
  const rows = rawRows.map((r) => {
    if (r.length === maxCols) return r;
    const padded = [...r];
    while (padded.length < maxCols) padded.push('');
    return padded;
  });

  return {
    fileName,
    format,
    headers,
    hasHeaderRow,
    rows,
    inferredLevel,
    detectedMapping: detectKanjiColumns(headers, rows),
  };
}

function buildTableFromJsonArray(
  arr: unknown[],
  fileName: string,
  inferredLevel: string | null
): ParsedKanjiTable {
  if (arr.length === 0) {
    return {
      fileName,
      format: 'json-array',
      headers: [],
      hasHeaderRow: true,
      rows: [],
      inferredLevel,
      detectedMapping: {
        charCol: 0,
        levelCol: -1,
        readingCol: -1,
        onCol: -1,
        kunCol: -1,
        meaningCol: -1,
        strokeCol: -1,
      },
    };
  }

  const firstNonNull = arr.find((item) => item !== null && item !== undefined);

  // Array of strings: ["気", "学", "校"]
  if (typeof firstNonNull === 'string') {
    const headers = ['character'];
    const rows = arr.map((item) => [String(item ?? '').normalize('NFC').trim()]);
    return {
      fileName,
      format: 'json-array',
      headers,
      hasHeaderRow: true,
      rows,
      inferredLevel,
      detectedMapping: detectKanjiColumns(headers, rows),
    };
  }

  // Array of arrays: [["気", 5], ...]
  if (Array.isArray(firstNonNull)) {
    const maxCols = Math.max(...arr.slice(0, 25).map((r) => (Array.isArray(r) ? r.length : 1)));
    const headers = Array.from({ length: maxCols }, (_, i) => `Column ${i + 1}`);
    const rows = arr.map((r) => {
      const a = Array.isArray(r) ? r : [r];
      return headers.map((_, i) => formatJsonValue(a[i]));
    });
    return {
      fileName,
      format: 'json-array',
      headers,
      hasHeaderRow: false,
      rows,
      inferredLevel,
      detectedMapping: detectKanjiColumns(headers, rows),
    };
  }

  // Array of objects: [{"kanji": "気", "jlpt": 5}, ...]
  const keySet = new Set<string>();
  const sampleItems = arr.slice(0, 100);
  for (const item of sampleItems) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const k of Object.keys(item)) {
        keySet.add(k);
      }
    }
  }

  const rawHeaders = Array.from(keySet);
  const KANJI_ALIASES = ['kanji', 'character', 'char', 'expression', 'word', 'glyph', 'symbol'];
  const LEVEL_ALIASES = ['jlpt', 'level', 'jlpt_level', 'jlptLevel', 'lvl', 'jlpt_lvl'];

  const findExclusiveGroup = (aliases: string[]) => {
    const present = rawHeaders.filter((h) => aliases.includes(h.toLowerCase()));
    if (present.length <= 1) return null;
    const hasCollision = sampleItems.some((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const obj = item as Record<string, unknown>;
      let count = 0;
      for (const k of present) {
        if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') count++;
      }
      return count > 1;
    });
    return hasCollision ? null : present;
  };

  const kanjiGroup = findExclusiveGroup(KANJI_ALIASES);
  const levelGroup = findExclusiveGroup(LEVEL_ALIASES);

  const mergedSourceKeys = new Map<string, string[]>();
  const headers: string[] = [];
  for (const h of rawHeaders) {
    if (kanjiGroup && kanjiGroup.includes(h)) {
      if (h === kanjiGroup[0]) {
        const label = kanjiGroup.join(' / ');
        headers.push(label);
        mergedSourceKeys.set(label, kanjiGroup);
      }
    } else if (levelGroup && levelGroup.includes(h)) {
      if (h === levelGroup[0]) {
        const label = levelGroup.join(' / ');
        headers.push(label);
        mergedSourceKeys.set(label, levelGroup);
      }
    } else {
      headers.push(h);
      mergedSourceKeys.set(h, [h]);
    }
  }

  const rows = arr.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return headers.map(() => '');
    }
    const obj = item as Record<string, unknown>;
    return headers.map((h) => {
      const keys = mergedSourceKeys.get(h) || [h];
      for (const k of keys) {
        const formatted = formatJsonValue(obj[k]);
        if (formatted !== '') return formatted;
      }
      return '';
    });
  });

  return {
    fileName,
    format: 'json-array',
    headers,
    hasHeaderRow: true,
    rows,
    inferredLevel,
    detectedMapping: detectKanjiColumns(headers, rows),
  };
}

/**
 * Generates up to 5 preview rows showing how each row will be parsed with the current column mapping.
 */
export function buildKanjiPreviewRows(
  table: ParsedKanjiTable,
  mapping: KanjiColumnMapping,
  limit = 5
): NormalizedKanjiPreviewRow[] {
  return table.rows.slice(0, limit).map((row, idx) => {
    const rawChar = mapping.charCol >= 0 ? (row[mapping.charCol] || '').normalize('NFC').trim() : '';
    if (!rawChar || !SINGLE_KANJI_REGEX.test(rawChar)) {
      return {
        rowIndex: idx + 1,
        rawRow: row,
        character: rawChar || '—',
        jlptLevel: 'Skipped',
        status: 'skipped',
        statusReason: 'Not a single kanji character',
      };
    }

    const rawLvl = mapping.levelCol >= 0 ? (row[mapping.levelCol] || '').trim() : '';
    const resolvedLvl = resolveRowJlptLevel(rawLvl, table.inferredLevel);
    const hadOutOfRangeLevel = rawLvl !== '' && normalizeJlptLevel(rawLvl) === null;

    return {
      rowIndex: idx + 1,
      rawRow: row,
      character: rawChar,
      jlptLevel: resolvedLvl,
      status: hadOutOfRangeLevel ? 'ignored-level' : 'valid',
      statusReason: hadOutOfRangeLevel ? `Ignored "${rawLvl}" (outside 1-5)` : undefined,
    };
  });
}
