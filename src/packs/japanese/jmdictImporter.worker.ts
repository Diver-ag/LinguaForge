import Dexie from 'dexie';
import JSZip from 'jszip';
import { deriveFrequencyInfo, deriveBandFromRank } from './jmdictFrequency';
import { computeFingerprint } from '../fingerprint';
import type { JmdictEntryItem, DictionaryMetaItem, ImportRecord, ImportKind, KanjiEntryItem } from '../../db/db';

// Worker DB connection matching LinguaForgeDatabase v6
class WorkerLinguaForgeDB extends Dexie {
  jmdictEntries!: Dexie.Table<JmdictEntryItem, string>;
  dictionaryMeta!: Dexie.Table<DictionaryMetaItem, string>;
  importedData!: Dexie.Table<any, number>;
  imports!: Dexie.Table<ImportRecord, string>;
  kanjiEntries!: Dexie.Table<KanjiEntryItem, string>;

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
    });
    this.version(5).stores({
      jmdictEntries: 'id, languageCode, *forms, *importIds, *kinds, priorityScore, frequencyBand, jlptLevel',
    });
    this.version(6).stores({
      kanjiEntries: 'character, jlptLevel, *importIds',
    });
  }
}

let isCancelled = false;
let hasNonEnglishFound = false;

// CSV Parser handling quotes and delimiters
function parseCsvRows(text: string): { headers: string[]; rows: string[][] } {
  const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (rawLines.length === 0) return { headers: [], rows: [] };

  const parsedLines: string[][] = [];
  for (const line of rawLines) {
    if (line.startsWith('#') || line.startsWith('//')) continue;
    const row: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if ((ch === ',' || ch === '\t') && !inQuotes) {
        row.push(cur.trim().replace(/^["']|["']$/g, ''));
        cur = '';
      } else {
        cur += ch;
      }
    }
    row.push(cur.trim().replace(/^["']|["']$/g, ''));
    if (row.some(Boolean)) {
      parsedLines.push(row);
    }
  }

  if (parsedLines.length === 0) return { headers: [], rows: [] };

  const first = parsedLines[0].map((s) => s.toLowerCase());
  const hasHeader = first.some((s) =>
    ['expression', 'word', 'kanji', 'reading', 'kana', 'level', 'jlpt', 'rank', 'frequency'].includes(s)
  );

  if (hasHeader) {
    return { headers: first, rows: parsedLines.slice(1) };
  }
  return { headers: [], rows: parsedLines };
}

function inferLevelFromFileName(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  const m = lower.match(/\b(n[1-5])\b|jlpt[-_ ]?([1-5])|[-_ ](n[1-5])[-_ .]/i);
  if (m) {
    const raw = m[1] || m[2] || m[3];
    return raw.toUpperCase().startsWith('N') ? raw.toUpperCase() : `N${raw}`;
  }
  if (lower.includes('n5')) return 'N5';
  if (lower.includes('n4')) return 'N4';
  if (lower.includes('n3')) return 'N3';
  if (lower.includes('n2')) return 'N2';
  if (lower.includes('n1')) return 'N1';
  return null;
}

function cleanJlptLevel(raw: string, fallbackLevel: string | null = null): string {
  let cleaned = (raw || '').trim().toUpperCase();
  if (/^[1-5]$/.test(cleaned)) cleaned = `N${cleaned}`;
  if (/^JLPTN?[1-5]$/.test(cleaned)) cleaned = `N${cleaned.slice(-1)}`;
  if (/^N[1-5]$/.test(cleaned)) return cleaned;
  if (fallbackLevel && /^N[1-5]$/.test(fallbackLevel)) return fallbackLevel;
  return 'No level';
}

function isEasierLevel(candidateLevel: string, existingLevel: string): boolean {
  const cNum = parseInt(candidateLevel.replace(/\D/g, ''), 10);
  const eNum = parseInt(existingLevel.replace(/\D/g, ''), 10);
  if (!eNum || isNaN(eNum)) return true;
  if (!cNum || isNaN(cNum)) return false;
  // N5 (5) > N4 (4) -> higher number is easier
  return cNum > eNum;
}

// Convert raw buffer or string to JSON text, handling .zip and .gz
async function extractJsonText(
  data: ArrayBuffer | string,
  fileName = ''
): Promise<{ text: string; sizeBytes: number }> {
  let sizeBytes = typeof data === 'string' ? data.length : data.byteLength;

  if (typeof data === 'string') {
    return { text: data, sizeBytes };
  }

  const uint8 = new Uint8Array(data);

  // Check if ZIP archive (PK\x03\x04 or .zip extension)
  if (
    (uint8[0] === 0x50 && uint8[1] === 0x4b && uint8[2] === 0x03 && uint8[3] === 0x04) ||
    fileName.endsWith('.zip')
  ) {
    self.postMessage({ type: 'status', message: 'Decompressing ZIP archive...' });
    const zip = await JSZip.loadAsync(data);
    const jsonFile = Object.values(zip.files).find(
      (f) => !f.dir && f.name.toLowerCase().endsWith('.json')
    );
    if (!jsonFile) {
      throw new Error('No .json dictionary file found inside the ZIP archive');
    }
    const text = await jsonFile.async('text');
    return { text, sizeBytes };
  }

  // Check if GZIP archive (0x1F 0x8B or .gz extension)
  if ((uint8[0] === 0x1f && uint8[1] === 0x8b) || fileName.endsWith('.gz')) {
    self.postMessage({ type: 'status', message: 'Decompressing GZIP stream...' });
    if (typeof DecompressionStream !== 'undefined') {
      const stream = new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip')));
      const text = await stream.text();
      return { text, sizeBytes };
    }
  }

  // Standard text/json
  const decoder = new TextDecoder('utf-8');
  const text = decoder.decode(uint8);
  return { text, sizeBytes };
}

// Transform raw JMdict or names word into indexed entry
function transformWord(
  w: any,
  index: number,
  kind: ImportKind,
  languageCode: string
): JmdictEntryItem {
  const kanjiList: { text: string; common?: boolean; tags?: string[] }[] = (w.kanji || []).map((k: any) => ({
    text: k.text || '',
    common: !!k.common,
    tags: Array.isArray(k.tags) ? k.tags : [],
  }));

  const kanaList: { text: string; common?: boolean; tags?: string[] }[] = (w.kana || []).map((k: any) => ({
    text: k.text || '',
    common: !!k.common,
    tags: Array.isArray(k.tags) ? k.tags : [],
  }));

  // Collect all forms for indexing (all kanji spellings + all kana readings)
  const formsSet = new Set<string>();
  for (const k of kanjiList) if (k.text) formsSet.add(k.text);
  for (const r of kanaList) if (r.text) formsSet.add(r.text);

  // Collect all priority tags
  const tagsSet = new Set<string>();
  for (const k of kanjiList) for (const t of k.tags || []) tagsSet.add(t);
  for (const r of kanaList) for (const t of r.tags || []) tagsSet.add(t);
  const priorityTags = Array.from(tagsSet);

  const freq = deriveFrequencyInfo(priorityTags);

  // Parse senses, filtering strictly to English glosses only (Requirement 6)
  const senses: { partsOfSpeech: string[]; glosses: string[] }[] = (w.sense || []).map((s: any) => {
    const glosses: string[] = [];
    if (Array.isArray(s.gloss)) {
      for (const g of s.gloss) {
        if (typeof g === 'string') {
          glosses.push(g);
        } else if (g && typeof g === 'object') {
          const lang = g.lang || g['xml:lang'];
          if (lang && lang !== 'eng' && lang !== 'en') {
            hasNonEnglishFound = true;
          } else {
            const txt = g.text || g.$;
            if (txt) glosses.push(txt);
          }
        }
      }
    }

    const partsOfSpeech: string[] = Array.isArray(s.partOfSpeech)
      ? s.partOfSpeech
      : typeof s.partOfSpeech === 'string'
      ? [s.partOfSpeech]
      : [];

    return { partsOfSpeech, glosses };
  }).filter((s: { partsOfSpeech: string[]; glosses: string[] }) => s.glosses.length > 0 || s.partsOfSpeech.length > 0);

  const primaryWord = kanjiList[0]?.text || kanaList[0]?.text || `word-${index}`;
  const primaryReading = kanaList[0]?.text || '';

  // Detect id
  const entryId = String(w.id || `${kind}-${primaryWord}-${index}`);

  return {
    id: entryId,
    languageCode,
    forms: Array.from(formsSet),
    kanji: kanjiList,
    kana: kanaList,
    senses,
    primaryWord,
    primaryReading,
    priorityScore: freq.priorityScore,
    priorityTags,
    frequencyBand: freq.frequencyBand,
    frequencyRank: freq.frequencyRank,
    importIds: [],
    kinds: [kind],
  };
}

self.addEventListener('message', async (e: MessageEvent) => {
  const data = e.data || {};

  if (data.type === 'cancel') {
    isCancelled = true;
    return;
  }

  if (data.type === 'start') {
    isCancelled = false;
    hasNonEnglishFound = false;
    const {
      source,
      fileData,
      url,
      fileName,
      languageCode = 'ja',
      explicitKind,
      forceReplace = false,
      existingImportId,
      columnMapping,
      files,
    } = data;

    try {
      let rawData: ArrayBuffer | string;
      let effectiveFileName = fileName || '';

      if (source === 'url') {
        if (!url) throw new Error('No URL specified for download');
        self.postMessage({ type: 'status', message: `Connecting to ${url}...` });

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText} while fetching dictionary`);
        }
        effectiveFileName = fileName || url.split('?')[0].split('/').pop() || 'dictionary.json';
        rawData = await response.arrayBuffer();
      } else {
        rawData = fileData;
      }

      // Compute content fingerprint (SHA-256 of first 1MB + last 1MB + size)
      self.postMessage({ type: 'status', message: 'Computing content fingerprint...' });
      const rawBytes = typeof rawData === 'string' ? new TextEncoder().encode(rawData) : rawData;
      const fingerprint = await computeFingerprint(rawBytes);

      self.postMessage({ type: 'status', message: 'Decompressing & reading data...' });
      const { text, sizeBytes } = await extractJsonText(rawData, effectiveFileName);

      // Parse JSON or detect CSV
      let parsed: any = null;
      let isCsv = effectiveFileName.toLowerCase().endsWith('.csv');
      const trimmed = text.trim();
      if (!isCsv && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
        try {
          parsed = JSON.parse(text);
        } catch {
          isCsv = true;
        }
      } else {
        isCsv = true;
      }

      // Determine kind
      let kind: ImportKind = explicitKind || parsed?.kind;
      if (!kind) {
        const lowerName = effectiveFileName.toLowerCase();
        if (lowerName.includes('name') || lowerName.includes('jmnedict')) {
          kind = 'names';
        } else if (
          lowerName.includes('kanji-level') ||
          lowerName.includes('kanji_level') ||
          lowerName.includes('jlpt-kanji') ||
          lowerName.includes('jlpt_kanji') ||
          lowerName.includes('kanjilevel')
        ) {
          kind = 'kanji-levels';
        } else if (lowerName.includes('kanji') || lowerName.includes('kanjidic')) {
          kind = 'kanji';
        } else if (lowerName.includes('sentence') || lowerName.includes('tatoeba')) {
          kind = 'sentences';
        } else if (lowerName.includes('jlpt')) {
          kind = 'jlpt';
        } else if (lowerName.includes('freq')) {
          kind = 'frequency';
        } else {
          kind = 'dictionary';
        }
      }

      const workerDb = new WorkerLinguaForgeDB();
      await workerDb.open();

      // Check if this exact file (same languageCode + kind + fingerprint) is already installed
      const existingMatching = await workerDb.imports
        .where('[languageCode+kind]')
        .equals([languageCode, kind])
        .toArray();
      const duplicate = existingMatching.find((m) => m.fingerprint === fingerprint);

      if (duplicate && !forceReplace) {
        self.postMessage({
          type: 'duplicate_fingerprint',
          existingImport: duplicate,
          fingerprint,
          fileName: effectiveFileName,
          kind,
          languageCode,
        });
        return;
      }

      // Generate or reuse importId
      const importId =
        forceReplace && (existingImportId || duplicate?.importId)
          ? existingImportId || duplicate!.importId
          : `imp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      // If force replacing, remove previous rows/references for this importId
      if (forceReplace && (existingImportId || duplicate?.importId)) {
        const targetId = existingImportId || duplicate!.importId;
        if (kind === 'kanji-levels') {
          const oldKanji = await workerDb.kanjiEntries
            .where('importIds')
            .equals(targetId)
            .toArray();

          for (const k of oldKanji) {
            const rem = (k.importIds || []).filter((id) => id !== targetId);
            if (rem.length === 0) {
              await workerDb.kanjiEntries.delete(k.character);
            } else {
              k.importIds = rem;
              await workerDb.kanjiEntries.put(k);
            }
          }
        } else {
          const oldEntries = await workerDb.jmdictEntries
            .where('importIds')
            .equals(targetId)
            .toArray();

          for (const entry of oldEntries) {
            const rem = (entry.importIds || []).filter((id) => id !== targetId);
            if (rem.length === 0) {
              await workerDb.jmdictEntries.delete(entry.id);
            } else {
              entry.importIds = rem;
              await workerDb.jmdictEntries.put(entry);
            }
          }
        }
      }

      // Dedicated pipeline for kanji-levels (independent of vocabulary matching)
      if (kind === 'kanji-levels') {
        const filesToProcess: Array<{ fileName: string; text: string; sizeBytes?: number; mapping?: any }> = [];

        if (Array.isArray(files) && files.length > 0) {
          for (const f of files) {
            const fText = typeof f.data === 'string' ? f.data : f.text || '';
            filesToProcess.push({
              fileName: f.fileName || f.name || 'kanji.csv',
              text: fText,
              sizeBytes: f.size || fText.length,
              mapping: f.columnMapping || columnMapping,
            });
          }
        } else {
          filesToProcess.push({
            fileName: effectiveFileName,
            text,
            sizeBytes,
            mapping: columnMapping,
          });
        }

        self.postMessage({
          type: 'status',
          message: `Parsing kanji data from ${filesToProcess.length} file(s)...`,
        });

        const perLevelCounts: Record<'N5' | 'N4' | 'N3' | 'N2' | 'N1' | 'No level', number> = {
          N5: 0,
          N4: 0,
          N3: 0,
          N2: 0,
          N1: 0,
          'No level': 0,
        };
        let duplicateCount = 0;
        let skippedCount = 0;
        const kanjiMap = new Map<string, KanjiEntryItem>();

        // Load existing entries to detect duplicates across imports and retain the easier level
        const existingEntries = await workerDb.kanjiEntries.toArray();
        const existingDbMap = new Map<string, KanjiEntryItem>();
        for (const entry of existingEntries) {
          existingDbMap.set(entry.character, entry);
        }

        for (const fileObj of filesToProcess) {
          const fName = fileObj.fileName;
          const inferredLevel = inferLevelFromFileName(fName);
          const { headers, rows } = parseCsvRows(fileObj.text);

          const mapping = fileObj.mapping || {};
          let charIdx = mapping.charCol ?? mapping.kanjiCol ?? -1;
          let lvlIdx = mapping.levelCol ?? mapping.jlptCol ?? -1;
          let readingIdx = mapping.readingCol ?? mapping.kanaCol ?? -1;
          let onIdx = mapping.onCol ?? -1;
          let kunIdx = mapping.kunCol ?? -1;
          let meaningIdx = mapping.meaningCol ?? mapping.glossCol ?? -1;
          let strokeIdx = mapping.strokeCol ?? -1;

          // Auto-detect columns from headers if not explicitly specified
          if (charIdx === -1) {
            charIdx = headers.findIndex((h) =>
              h.includes('kanji') || h.includes('char') || h.includes('character') || h === 'word' || h === 'expression'
            );
          }
          if (lvlIdx === -1) {
            lvlIdx = headers.findIndex((h) => h.includes('level') || h.includes('jlpt') || h.includes('grade'));
          }
          if (readingIdx === -1) {
            readingIdx = headers.findIndex((h) => h.includes('reading') || h.includes('kana') || h.includes('yomi'));
          }
          if (onIdx === -1) {
            onIdx = headers.findIndex((h) => h.includes('on') || h.includes('onyomi'));
          }
          if (kunIdx === -1) {
            kunIdx = headers.findIndex((h) => h.includes('kun') || h.includes('kunyomi'));
          }
          if (meaningIdx === -1) {
            meaningIdx = headers.findIndex((h) =>
              h.includes('mean') || h.includes('definition') || h.includes('english') || h.includes('gloss')
            );
          }
          if (strokeIdx === -1) {
            strokeIdx = headers.findIndex((h) => h.includes('stroke') || h.includes('strokes'));
          }

          // If still -1, inspect rows for single kanji column
          if (charIdx === -1 && rows.length > 0) {
            const sampleRows = rows.slice(0, 5);
            for (let c = 0; c < (sampleRows[0]?.length || 0); c++) {
              if (sampleRows.every((r) => r[c] && /^[\u4e00-\u9faf\u3400-\u4dbf々〆〇]$/.test(r[c].trim()))) {
                charIdx = c;
                break;
              }
            }
            if (charIdx === -1) charIdx = 0;
          }

          for (const row of rows) {
            const rawChar = (row[charIdx] || '').trim();
            // Validate single kanji ideograph
            if (!rawChar || !/^[\u4e00-\u9faf\u3400-\u4dbf々〆〇]$/.test(rawChar)) {
              skippedCount++;
              continue;
            }

            // Extract level
            const rawLvl = lvlIdx !== -1 ? row[lvlIdx] : '';
            const lvl = cleanJlptLevel(rawLvl, inferredLevel);

            // Extract readings
            const onReadings: string[] = [];
            const kunReadings: string[] = [];
            if (onIdx !== -1 && row[onIdx]) {
              onReadings.push(...row[onIdx].split(/[,;/、\s]+/).map((s) => s.trim()).filter(Boolean));
            }
            if (kunIdx !== -1 && row[kunIdx]) {
              kunReadings.push(...row[kunIdx].split(/[,;/、\s]+/).map((s) => s.trim()).filter(Boolean));
            }
            if (readingIdx !== -1 && row[readingIdx] && onReadings.length === 0 && kunReadings.length === 0) {
              const rParts = row[readingIdx].split(/[,;/、\s]+/).map((s) => s.trim()).filter(Boolean);
              for (const r of rParts) {
                if (/[\u30a0-\u30ff]/.test(r)) onReadings.push(r);
                else kunReadings.push(r);
              }
            }

            // Extract meanings
            const meanings: string[] = [];
            if (meaningIdx !== -1 && row[meaningIdx]) {
              meanings.push(...row[meaningIdx].split(/[,;/|]+/).map((s) => s.trim()).filter(Boolean));
            }

            // Extract strokes
            let strokeCount: number | undefined = undefined;
            if (strokeIdx !== -1 && row[strokeIdx]) {
              const parsedStroke = parseInt(row[strokeIdx].replace(/\D/g, ''), 10);
              if (!isNaN(parsedStroke) && parsedStroke > 0) strokeCount = parsedStroke;
            }

            // Duplicate detection across current batch and existing database
            const existingInBatch = kanjiMap.get(rawChar);
            const existingInDb = existingDbMap.get(rawChar);

            if (existingInBatch || existingInDb) {
              duplicateCount++;
              const current = existingInBatch || existingInDb!;
              // Keep easier level (N5 > N4 > N3 > N2 > N1)
              if (isEasierLevel(lvl, current.jlptLevel)) {
                current.jlptLevel = lvl;
              }
              // Merge readings, meanings, strokeCount
              if (onReadings.length > 0) {
                const combined = Array.from(new Set([...(current.readings?.on || []), ...onReadings]));
                current.readings = { ...current.readings, on: combined };
              }
              if (kunReadings.length > 0) {
                const combined = Array.from(new Set([...(current.readings?.kun || []), ...kunReadings]));
                current.readings = { ...current.readings, kun: combined };
              }
              if (meanings.length > 0) {
                current.meanings = Array.from(new Set([...(current.meanings || []), ...meanings]));
              }
              if (strokeCount && !current.strokeCount) {
                current.strokeCount = strokeCount;
              }
              current.importIds = Array.from(new Set([...(current.importIds || []), importId]));
              current.updatedAt = Date.now();
              kanjiMap.set(rawChar, current);
            } else {
              const newEntry: KanjiEntryItem = {
                character: rawChar,
                jlptLevel: lvl,
                readings: onReadings.length > 0 || kunReadings.length > 0 ? { on: onReadings, kun: kunReadings } : undefined,
                meanings: meanings.length > 0 ? meanings : undefined,
                strokeCount,
                importIds: [importId],
                updatedAt: Date.now(),
              };
              kanjiMap.set(rawChar, newEntry);
            }
          }
        }

        // Calculate per-level counts
        const kanjiEntriesList = Array.from(kanjiMap.values());
        for (const k of kanjiEntriesList) {
          const l = (k.jlptLevel && /^N[1-5]$/.test(k.jlptLevel) ? k.jlptLevel : 'No level') as keyof typeof perLevelCounts;
          perLevelCounts[l] = (perLevelCounts[l] || 0) + 1;
        }

        self.postMessage({
          type: 'status',
          message: `Saving ${kanjiEntriesList.length.toLocaleString()} kanji entries...`,
        });

        const BATCH_SIZE = 500;
        let processed = 0;
        const total = kanjiEntriesList.length;

        for (let i = 0; i < total; i += BATCH_SIZE) {
          if (isCancelled) {
            self.postMessage({ type: 'cancelled' });
            return;
          }
          const chunk = kanjiEntriesList.slice(i, i + BATCH_SIZE);
          await workerDb.kanjiEntries.bulkPut(chunk);
          processed += chunk.length;
          const percent = Math.min(100, Math.round((processed / total) * 100));
          self.postMessage({ type: 'progress', processed, total, percent });
        }

        const totalFileBytes = filesToProcess.reduce((acc, f) => acc + (f.sizeBytes || f.text.length), 0);
        const compositeFileName =
          filesToProcess.length > 1
            ? `${filesToProcess.length} kanji files (${filesToProcess[0].fileName}...)`
            : filesToProcess[0].fileName;

        // Save import record
        await workerDb.imports.put({
          importId,
          languageCode,
          kind: 'kanji-levels',
          fileName: compositeFileName,
          fileSize: totalFileBytes,
          fingerprint,
          date: Date.now(),
          entryCount: total,
          version: '1.0',
        });

        self.postMessage({
          type: 'complete',
          importId,
          kind: 'kanji-levels',
          count: total,
          perLevelCounts,
          duplicateCount,
          skippedCount,
          fileName: compositeFileName,
          fileSize: totalFileBytes,
          languageCode,
        });
        return;
      }

      // Check if overlay data (JLPT lists, Frequency lists)
      if (kind === 'jlpt' || kind === 'frequency') {
        let items: any[] = [];

        if (isCsv) {
          const { headers, rows } = parseCsvRows(text);
          if (kind === 'jlpt') {
            const expIdx = headers.findIndex((h) => h.includes('exp') || h.includes('word') || h.includes('kanji'));
            const readIdx = headers.findIndex((h) => h.includes('read') || h.includes('kana'));
            const lvlIdx = headers.findIndex((h) => h.includes('level') || h.includes('jlpt'));

            for (const r of rows) {
              let expression = '';
              let reading = '';
              let rawLevel = '';

              if (headers.length > 0) {
                expression = r[expIdx !== -1 ? expIdx : 0] || '';
                reading = readIdx !== -1 ? r[readIdx] : '';
                rawLevel = lvlIdx !== -1 ? r[lvlIdx] : (r[2] || r[1]);
              } else {
                if (r.length >= 3) {
                  expression = r[0];
                  reading = r[1];
                  rawLevel = r[2];
                } else if (r.length === 2) {
                  expression = r[0];
                  rawLevel = r[1];
                }
              }

              let cleanLevel = rawLevel ? rawLevel.toUpperCase().replace(/\s+/g, '') : '';
              if (/^[1-5]$/.test(cleanLevel)) cleanLevel = `N${cleanLevel}`;
              if (/^JLPTN?[1-5]$/.test(cleanLevel)) cleanLevel = `N${cleanLevel.slice(-1)}`;

              if (expression && /^N[1-5]$/.test(cleanLevel)) {
                items.push({ expression, reading, level: cleanLevel });
              }
            }
          } else {
            // frequency
            const wordIdx = headers.findIndex((h) => h.includes('word') || h.includes('exp') || h.includes('kanji'));
            const rankIdx = headers.findIndex((h) => h.includes('rank') || h.includes('freq') || h.includes('count'));

            for (const r of rows) {
              const word = r[wordIdx !== -1 ? wordIdx : 0] || '';
              const rawRank = r[rankIdx !== -1 ? rankIdx : 1] || '';
              const rank = parseInt(rawRank.replace(/[^0-9]/g, ''), 10);
              if (word && !isNaN(rank) && rank > 0) {
                items.push({ word, rank });
              }
            }
          }
        } else if (parsed) {
          const rawItems = parsed.items || parsed.words || (Array.isArray(parsed) ? parsed : []);
          items = rawItems.map((it: any) => ({
            expression: it.expression || it.word || it.text || it.surface,
            reading: it.reading || it.kana,
            level: it.level || it.jlptLevel,
            word: it.word || it.expression || it.text || it.surface,
            rank: it.rank || it.frequencyRank,
          })).filter((it: any) => (kind === 'jlpt' ? it.expression && it.level : it.word && it.rank));
        }

        const total = items.length;
        let matchedCount = 0;
        let unmatchedCount = 0;
        let ambiguousCount = 0;
        const unmatchedList: any[] = [];
        const ambiguousList: any[] = [];

        self.postMessage({
          type: 'status',
          message: `Applying ${total.toLocaleString()} ${kind.toUpperCase()} overlay entries...`,
        });

        const BATCH_SIZE = 500;
        let processed = 0;

        for (let i = 0; i < total; i += BATCH_SIZE) {
          if (isCancelled) {
            self.postMessage({ type: 'cancelled' });
            return;
          }

          const chunk = items.slice(i, i + BATCH_SIZE);
          for (const item of chunk) {
            if (kind === 'jlpt') {
              const expr = item.expression;
              const reading = item.reading;
              const lvl = item.level;

              // Match by kanji form
              const surfaceMatches = await workerDb.jmdictEntries.where('forms').equals(expr).toArray();
              const langMatches = surfaceMatches.filter((e) => !e.languageCode || e.languageCode === languageCode);

              let targetEntries: JmdictEntryItem[] = [];

              if (langMatches.length === 0) {
                unmatchedCount++;
                if (unmatchedList.length < 50) {
                  unmatchedList.push({ word: expr, reading, level: lvl });
                }
              } else if (reading && reading !== expr) {
                // Match by kanji form + reading
                const readingMatches = langMatches.filter((e) =>
                  (e.kana && e.kana.some((k) => k.text === reading)) ||
                  (e.forms && e.forms.includes(reading))
                );
                if (readingMatches.length > 0) {
                  targetEntries = readingMatches;
                } else {
                  // Falling back to kanji form alone
                  targetEntries = langMatches;
                }
              } else {
                targetEntries = langMatches;
              }

              if (targetEntries.length === 1) {
                matchedCount++;
              } else if (targetEntries.length > 1) {
                ambiguousCount++;
                if (ambiguousList.length < 50) {
                  ambiguousList.push({ word: expr, reading, level: lvl, matchCount: targetEntries.length });
                }
              }

              for (const entry of targetEntries) {
                entry.importIds = Array.from(new Set([...(entry.importIds || []), importId]));
                entry.kinds = Array.from(new Set([...(entry.kinds || []), 'jlpt']));
                entry.overlayData = entry.overlayData || {};
                entry.overlayData[importId] = { jlptLevel: lvl };
                entry.jlptLevel = lvl;
                await workerDb.jmdictEntries.put(entry);
              }
            } else if (kind === 'frequency') {
              const word = item.word;
              const rank = item.rank;

              const surfaceMatches = await workerDb.jmdictEntries.where('forms').equals(word).toArray();
              const langMatches = surfaceMatches.filter((e) => !e.languageCode || e.languageCode === languageCode);

              if (langMatches.length === 0) {
                unmatchedCount++;
                if (unmatchedList.length < 50) {
                  unmatchedList.push({ word, rank });
                }
              } else if (langMatches.length === 1) {
                matchedCount++;
              } else {
                ambiguousCount++;
                if (ambiguousList.length < 50) {
                  ambiguousList.push({ word, rank, matchCount: langMatches.length });
                }
              }

              const band = deriveBandFromRank(rank);
              for (const entry of langMatches) {
                entry.importIds = Array.from(new Set([...(entry.importIds || []), importId]));
                entry.kinds = Array.from(new Set([...(entry.kinds || []), 'frequency']));
                entry.overlayData = entry.overlayData || {};
                entry.overlayData[importId] = { frequencyRank: rank };
                entry.frequencyRank = rank;
                entry.frequencyBand = band;
                await workerDb.jmdictEntries.put(entry);
              }
            }
          }

          processed += chunk.length;
          const percent = Math.min(100, Math.round((processed / total) * 100));
          self.postMessage({ type: 'progress', processed, total, percent });
        }

        // Save import record
        await workerDb.imports.put({
          importId,
          languageCode,
          kind,
          fileName: effectiveFileName,
          fileSize: sizeBytes,
          fingerprint,
          date: Date.now(),
          entryCount: total,
          version: parsed?.version || '1.0',
        });

        self.postMessage({
          type: 'complete',
          importId,
          count: total,
          fileName: effectiveFileName,
          matchedCount,
          unmatchedCount,
          ambiguousCount,
          unmatchedSample: unmatchedList,
          ambiguousSample: ambiguousList,
          version: parsed?.version || '1.0',
          sizeBytes,
          kind,
          languageCode,
        });
        return;
      }

      // Standard dictionary, names, or kanji entries
      const rawWords = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.words)
        ? parsed.words
        : Array.isArray(parsed.entries)
        ? parsed.entries
        : null;

      if (!rawWords || rawWords.length === 0) {
        throw new Error('Invalid format: expected array of words/entries');
      }

      const total = rawWords.length;
      self.postMessage({
        type: 'status',
        message: `Found ${total.toLocaleString()} entries. Upserting into local database...`,
      });

      const BATCH_SIZE = 1000;
      let processed = 0;

      for (let i = 0; i < total; i += BATCH_SIZE) {
        if (isCancelled) {
          self.postMessage({ type: 'cancelled' });
          return;
        }

        const chunkSlice = rawWords.slice(i, i + BATCH_SIZE);
        const batch: JmdictEntryItem[] = [];

        for (let idx = 0; idx < chunkSlice.length; idx++) {
          const raw = chunkSlice[idx];
          const newEntry = transformWord(raw, i + idx, kind, languageCode);

          // Check if this entry already exists to merge by upsert (Requirement 3)
          const existing = await workerDb.jmdictEntries.get(newEntry.id);

          if (existing) {
            // Merge importIds without duplicates
            existing.importIds = Array.from(
              new Set([...(existing.importIds || []), importId])
            );
            // Merge kinds
            existing.kinds = Array.from(new Set([...(existing.kinds || []), kind]));

            // Merge forms
            existing.forms = Array.from(new Set([...existing.forms, ...newEntry.forms]));

            // Merge unique kanji & kana
            const seenKanji = new Set(existing.kanji.map((k) => k.text));
            for (const k of newEntry.kanji) {
              if (!seenKanji.has(k.text)) existing.kanji.push(k);
            }

            const seenKana = new Set(existing.kana.map((k) => k.text));
            for (const k of newEntry.kana) {
              if (!seenKana.has(k.text)) existing.kana.push(k);
            }

            // Merge senses
            existing.senses = [...existing.senses, ...newEntry.senses];
            existing.priorityScore = Math.max(existing.priorityScore, newEntry.priorityScore);

            batch.push(existing);
          } else {
            newEntry.importIds = [importId];
            newEntry.kinds = [kind];
            newEntry.languageCode = languageCode;
            batch.push(newEntry);
          }
        }

        await workerDb.jmdictEntries.bulkPut(batch);
        processed += chunkSlice.length;

        const percent = Math.min(100, Math.round((processed / total) * 100));
        self.postMessage({
          type: 'progress',
          processed,
          total,
          percent,
        });

        // Yield slightly
        await new Promise((r) => setTimeout(r, 0));
      }

      // Save import record in imports table (Requirement 1)
      const importRecord: ImportRecord = {
        importId,
        languageCode,
        kind,
        fileName: effectiveFileName,
        fileSize: sizeBytes,
        fingerprint,
        date: Date.now(),
        entryCount: total,
        version: parsed.version || parsed.dictDate || '1.0',
        hasNonEnglishGlosses: hasNonEnglishFound,
      };
      await workerDb.imports.put(importRecord);

      self.postMessage({
        type: 'complete',
        importId,
        fileName: effectiveFileName,
        count: total,
        version: importRecord.version,
        sizeBytes: importRecord.fileSize,
        hasNonEnglishGlosses: hasNonEnglishFound,
        kind,
        languageCode,
      });
    } catch (err: any) {
      self.postMessage({
        type: 'error',
        error: err?.message || String(err),
      });
    }
  }
});
