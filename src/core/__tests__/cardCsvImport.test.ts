import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { db } from '../../db/db';
import { exportFullBackup, restoreFromBackup } from '../backup';
import {
  buildFailedRowsCsv,
  computeLayoutSignature,
  decodeUploadedTextBuffer,
  detectCsvDelimiter,
  detectDefaultColumnMapping,
  detectHasHeaderRow,
  loadSavedColumnMappings,
  parseDelimitedText,
  parseInlineFurigana,
  runCardCsvImport,
  saveColumnMappingForLayout,
} from '../cardCsvImport';
import { tokenizeWithIntlSegmenter } from '../../packs/japanese/tokenizer';

async function runTests() {
  console.log('--- Running Card CSV/TSV Import Tests ---');

  await db.delete();
  await db.open();

  // 1. Encoding & BOM Detection
  const utf8Text = 'Word,Reading,Meaning\n食べる,たべる,to eat';
  const utf8Buf = new TextEncoder().encode(utf8Text).buffer;
  const decNoBom = decodeUploadedTextBuffer(utf8Buf);
  assert.equal(decNoBom.encodingLabel, 'UTF-8');
  assert.equal(decNoBom.hasBom, false);
  assert.ok(decNoBom.text.startsWith('Word,'));

  const rawBytes = new TextEncoder().encode(utf8Text);
  const bomBytes = new Uint8Array(3 + rawBytes.length);
  bomBytes.set([0xef, 0xbb, 0xbf], 0);
  bomBytes.set(rawBytes, 3);
  const decBom = decodeUploadedTextBuffer(bomBytes.buffer);
  assert.equal(decBom.encodingLabel, 'UTF-8 with BOM');
  assert.equal(decBom.hasBom, true);
  assert.ok(decBom.text.startsWith('Word,'), 'BOM must be stripped cleanly');
  console.log('PASS: Encoding & BOM detection');

  // 2. Delimiter Detection & Quoted Parsing
  const tsvInput = 'Word\tReading\tMeaning\tSentence\n"図書館"\tとしょかん\t"library, study hall"\t図書館で読む。';
  assert.equal(detectCsvDelimiter(tsvInput, 'vocab.txt'), '\t');
  const parsedTsv = parseDelimitedText(tsvInput, '\t');
  assert.equal(parsedTsv.length, 2);
  assert.equal(parsedTsv[1][2], 'library, study hall');

  const csvInput = 'word,reading,meaning,tags\n"学校","がっこう","school, academy","n5, basic"';
  assert.equal(detectCsvDelimiter(csvInput, 'vocab.csv'), ',');
  const parsedCsv = parseDelimitedText(csvInput, ',');
  assert.equal(parsedCsv.length, 2);
  assert.equal(parsedCsv[1][3], 'n5, basic');
  console.log('PASS: Delimiter detection & quoted cell parsing');

  // 3. Header Detection, Mapping & Layout Persistence
  assert.equal(detectHasHeaderRow(parsedCsv[0]), true);
  const autoMap = detectDefaultColumnMapping(parsedCsv[0], true, 4);
  assert.deepEqual(autoMap, ['word', 'reading', 'meaning', 'tags']);

  const sig = computeLayoutSignature(parsedCsv[0], true, 4, ',');
  await saveColumnMappingForLayout({
    layoutKey: sig,
    mapping: ['word', 'reading', 'meaning', 'notes'],
    hasHeaderRow: true,
    delimiter: ',',
    updatedAt: Date.now(),
  });
  const loadedMappings = await loadSavedColumnMappings();
  assert.deepEqual(loadedMappings[sig].mapping, ['word', 'reading', 'meaning', 'notes']);
  console.log('PASS: Header detection & remembered layout mapping');

  // 4. Inline Furigana Parser
  const rubyParsed = parseInlineFurigana('<ruby>食<rt>た</rt></ruby>べる');
  assert.equal(rubyParsed.plainText, '食べる');
  assert.equal(rubyParsed.reading, 'たべる');
  assert.deepEqual(rubyParsed.segments, [{ text: '食', ruby: 'た' }, { text: 'べる' }]);

  const ankiParsed = parseInlineFurigana('日[に] 本[ほん]');
  assert.equal(ankiParsed.plainText, '日本');
  assert.equal(ankiParsed.reading, 'にほん');
  console.log('PASS: Inline <ruby> and Anki bracket furigana parsing');

  // 5. Full Import with Tokenizer Furigana, Error Rows, New Deck & Duplicate Modes
  const importRows = [
    ['word', 'reading', 'meaning', 'sentence', 'tags', 'notes', 'level', 'deck'],
    ['食べる', 'たべる', 'to eat', '朝ごはんを食べる。', 'food, jlpt', 'ichidan verb', 'N5', ''],
    ['店員', 'てんいん', 'store clerk', '店員に聞く。', 'work', 'noun', 'N4', 'Work Vocab'],
    ['', 'むし', 'missing word row', '', '', '', '', ''],
    ['電車', 'でんしゃ', '', '電車に乗る。', '', '', 'N5', ''], // missing meaning -> error
    ['食べる', 'たべる', 'to eat duplicate', '', '', '', 'N5', ''], // duplicate in same batch
  ];

  const progressTicks: number[] = [];
  const res1 = await runCardCsvImport(
    importRows,
    {
      languageId: 'ja',
      mapping: ['word', 'reading', 'meaning', 'sentence', 'tags', 'notes', 'level', 'deck'],
      hasHeaderRow: true,
      newDeckName: 'Imported Core',
      cardType: 'word_to_meaning',
      duplicateMode: 'skip',
      batchSize: 2,
    },
    {
      tokenizeFn: async (txt) => tokenizeWithIntlSegmenter(txt),
      onProgress: (p) => progressTicks.push(p.percent),
      skipSideEffects: true,
    }
  );

  assert.equal(res1.rowsRead, 5);
  assert.equal(res1.cardsCreated, 2);
  assert.equal(res1.skippedDuplicates, 1);
  assert.equal(res1.failedRows.length, 2);
  assert.ok(res1.createdDeckNames.includes('Imported Core'));
  assert.ok(res1.createdDeckNames.includes('Work Vocab'));
  assert.ok(progressTicks[progressTicks.length - 1] === 100);

  const storedCards = await db.cards.where('languageId').equals('ja').toArray();
  const taberu = storedCards.find((c) => c.word === '食べる');
  assert.ok(taberu, '食べる card must be stored');
  assert.ok(
    taberu.furiganaSegments && taberu.furiganaSegments.some((s) => s.ruby === 'た'),
    'Furigana segments must be generated when reading is available'
  );
  assert.equal(taberu.level, 'N5');
  assert.deepEqual(taberu.tags, ['food', 'jlpt']);

  const failedCsv = buildFailedRowsCsv(res1.failedRows, importRows[0]);
  assert.ok(failedCsv.text.startsWith('\uFEFFRowNumber,ErrorReason,word'));
  assert.ok(failedCsv.text.includes("Missing required 'word' field."));
  assert.ok(failedCsv.text.includes("Missing 'meaning' value"));
  console.log('PASS: Import batching, tokenizer furigana, duplicate skip, and failed-row CSV');

  // 6. Update Existing Cards Instead (preserving FSRS scheduling state)
  await db.cards.update(taberu.id, { reps: 7, stability: 12.5, state: 2 });
  const updateRows = [
    ['word', 'reading', 'meaning', 'notes'],
    ['食べる', 'たべる', 'to eat; to consume', 'updated note'],
  ];
  const res2 = await runCardCsvImport(
    updateRows,
    {
      languageId: 'ja',
      mapping: ['word', 'reading', 'meaning', 'notes'],
      hasHeaderRow: true,
      cardType: 'word_to_meaning',
      duplicateMode: 'update',
    },
    {
      tokenizeFn: async (txt) => tokenizeWithIntlSegmenter(txt),
      skipSideEffects: true,
    }
  );
  assert.equal(res2.cardsUpdated, 1);
  assert.equal(res2.cardsCreated, 0);
  const updatedTaberu = await db.cards.get(taberu.id);
  assert.equal(updatedTaberu?.meaning, 'to eat; to consume');
  assert.equal(updatedTaberu?.notes, 'updated note');
  assert.equal(updatedTaberu?.reps, 7, 'Existing FSRS reps must be preserved on update');
  assert.equal(updatedTaberu?.stability, 12.5, 'Existing FSRS stability must be preserved');
  console.log('PASS: Update existing cards instead preserves FSRS progress');

  // 7. Cancellation Check
  let cancelNow = false;
  const manyRows = [
    ['word', 'meaning'],
    ...Array.from({ length: 30 }, (_, idx) => [`単語${idx}`, `meaning ${idx}`]),
  ];
  const resCancel = await runCardCsvImport(
    manyRows,
    {
      languageId: 'ja',
      mapping: ['word', 'meaning'],
      hasHeaderRow: true,
      cardType: 'word_to_meaning',
      duplicateMode: 'skip',
      batchSize: 10,
    },
    {
      onProgress: () => {
        cancelNow = true; // Cancel right after first batch
      },
      isCancelled: () => cancelNow,
      skipSideEffects: true,
    }
  );
  assert.equal(resCancel.cancelled, true);
  assert.equal(resCancel.cardsCreated, 10);
  console.log('PASS: Mid-import cancellation stops cleanly after current batch');

  // 8. Backup & Restore Round-Trip
  const backupJson = await exportFullBackup();
  await db.cards.clear();
  await db.decks.clear();
  await db.settings.clear();

  const restoreRes = await restoreFromBackup(backupJson);
  assert.equal(restoreRes.success, true);

  const restoredMappings = await loadSavedColumnMappings();
  assert.deepEqual(restoredMappings[sig].mapping, ['word', 'reading', 'meaning', 'notes']);
  const restoredCards = await db.cards.toArray();
  assert.ok(restoredCards.some((c) => c.word === '食べる' && c.meaning === 'to eat; to consume'));
  const restoredDecks = await db.decks.toArray();
  assert.ok(restoredDecks.some((d) => d.name === 'Imported Core'));
  console.log('PASS: Backup & restore includes cards, decks, and remembered column mappings');

  console.log('ALL CARD CSV/TSV IMPORT TESTS PASSED');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
