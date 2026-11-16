import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import { db, type CardItem, type DeckItem } from '../../db/db';
import { buildAnkiExportPlan, buildAndVerifyApkg, ANKI_SCHEMA_DDL } from '../ankiExportCore';
import {
  ANKI_REEXPORT_HELP_MESSAGE,
  ankiHtmlToPlainText,
  createApkgWriteSession,
  detectDefaultApkgFieldMapping,
  extractDatabaseFromApkgZip,
  openAndInspectAnkiDb,
  parseAnkiFuriganaField,
  processApkgNoteBatch,
  sanitizeAnkiHtml,
  streamAnkiNoteBatches,
} from '../ankiImportCore';
import { exportFullBackup, restoreFromBackup } from '../backup';

function buildDummyAnki2Bytes(sqlJs: any): Uint8Array {
  const dummyDb = new sqlJs.Database();
  try {
    for (const stmt of ANKI_SCHEMA_DDL) dummyDb.run(stmt);
    dummyDb.run(
      `INSERT INTO col VALUES (1, 1700000000, 1700000000000, 1700000000000, 11, 0, 0, 0, '{}', ?, ?, '{}', '{}')`,
      [
        JSON.stringify({ '1': { id: 1, name: 'Basic', flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }] } }),
        JSON.stringify({ '1': { id: 1, name: 'Default' } }),
      ]
    );
    dummyDb.run(
      `INSERT INTO notes VALUES (1, 'dummyguid1', 1, 1700000000, -1, '', ?, 'Please update', 123, 0, '')`,
      ['Please update to the latest Anki version\x1f']
    );
    dummyDb.run(
      `INSERT INTO cards VALUES (1, 1, 1, 0, 1700000000, -1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, '{}')`
    );
    return dummyDb.export();
  } finally {
    dummyDb.close();
  }
}

function buildModernAnki21bSqliteBytes(sqlJs: any): Uint8Array {
  const modernDb = new sqlJs.Database();
  try {
    modernDb.run(`CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);`);
    modernDb.run(`INSERT INTO col VALUES (1, 1700000000, 1700000000000, 1700000000000, 18, 0, 0, 0, '{}', '', '', '{}', '{}');`);
    modernDb.run(`CREATE TABLE notetypes (id integer primary key, name text);`);
    modernDb.run(`CREATE TABLE fields (ntid integer, ord integer, name text);`);
    modernDb.run(`CREATE TABLE decks (id integer primary key, name text);`);
    modernDb.run(`CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld integer, csum integer, flags integer, data text);`);
    modernDb.run(`CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);`);

    modernDb.run(`INSERT INTO notetypes VALUES (2001, 'Core 2k Japanese');`);
    modernDb.run(`INSERT INTO fields VALUES (2001, 0, 'Vocab-kanji'), (2001, 1, 'Vocab-kana'), (2001, 2, 'Vocab-meaning'), (2001, 3, 'Sentence-jp'), (2001, 4, 'Notes');`);
    modernDb.run(`INSERT INTO decks VALUES (1, 'Default'), (3001, 'Japanese\x1fCore2k');`);

    modernDb.run(
      `INSERT INTO notes VALUES (5001, 'guid5001', 2001, 1700000000, -1, ' jlpt_n5 core ', ?, '約束', 111, 0, '')`,
      [
        [
          '<ruby>約束<rt>やくそく</rt></ruby>',
          'やくそく',
          '<b>promise</b><br>appointment<script>alert("xss")</script>',
          '友達[ともだち]と約束[やくそく]をする。[sound:rec1.mp3]',
          '<style>body{color:red}</style>Common noun',
        ].join('\x1f'),
      ]
    );
    modernDb.run(
      `INSERT INTO cards VALUES (6001, 5001, 3001, 0, 1700000000, -1, 2, 2, 100, 30, 2500, 15, 2, 0, 0, 0, 0, '{}')`
    );

    return modernDb.export();
  } finally {
    modernDb.close();
  }
}

async function runTests() {
  console.log('--- Running Anki .apkg Import Tests ---');

  await db.delete();
  await db.open();

  const initFn: any = typeof initSqlJs === 'function' ? initSqlJs : (initSqlJs as any).default;
  const sqlJs = await initFn({
    locateFile: () => path.resolve('public/sql-wasm.wasm'),
  });

  // 1. HTML Sanitization & Furigana Parsing
  const dirtyHtml =
    '<style>.a{display:none}</style><ruby>食<rt>た</rt></ruby>べる<br><b>verb</b><script>evil()</script>[sound:a.mp3]';
  const safeHtml = sanitizeAnkiHtml(dirtyHtml);
  assert.equal(safeHtml, '<ruby>食<rt>た</rt></ruby>べる<br><b>verb</b>');
  assert.ok(!safeHtml.includes('script') && !safeHtml.includes('style'));
  assert.equal(ankiHtmlToPlainText(dirtyHtml), '食べる\nverb');

  const bracketFuri = parseAnkiFuriganaField('図書館[としょかん]');
  assert.equal(bracketFuri.plainText, '図書館');
  assert.equal(bracketFuri.reading, 'としょかん');
  assert.deepEqual(bracketFuri.segments, [{ text: '図書館', ruby: 'としょかん' }]);

  const rubyFuri = parseAnkiFuriganaField('<ruby>桜<rt>さくら</rt></ruby>');
  assert.equal(rubyFuri.plainText, '桜');
  assert.equal(rubyFuri.reading, 'さくら');
  assert.deepEqual(rubyFuri.segments, [{ text: '桜', ruby: 'さくら' }]);
  console.log('PASS: HTML sanitization & Anki bracket/ruby furigana parsing');

  // 2. Field Auto-Detection
  const detectedMap = detectDefaultApkgFieldMapping([
    'Expression',
    'Reading',
    'Meaning',
    'Sentence',
    'Notes',
    'ExtraUnused',
  ]);
  assert.deepEqual(detectedMap, ['word', 'reading', 'meaning', 'sentence', 'notes', 'ignore']);
  const detectedCore = detectDefaultApkgFieldMapping([
    'Vocab-kanji',
    'Vocab-kana',
    'Vocab-meaning',
  ]);
  assert.deepEqual(detectedCore, ['word', 'reading', 'meaning']);
  console.log('PASS: Anki field name auto-detection');

  // 3. Dummy collection.anki2 rejection vs DB priority order
  const dummyBytes = buildDummyAnki2Bytes(sqlJs);
  const dummyZip = new JSZip();
  dummyZip.file('collection.anki2', dummyBytes);
  dummyZip.file('media', '{}');
  const dummyZipBytes = await dummyZip.generateAsync({ type: 'uint8array' });

  const extractedDummy = await extractDatabaseFromApkgZip(dummyZipBytes);
  assert.throws(
    () =>
      openAndInspectAnkiDb(
        extractedDummy.sqliteBytes,
        sqlJs,
        extractedDummy.dbSource,
        extractedDummy.skippedMediaCount,
        extractedDummy.hasNewerDb
      ),
    (err: any) => err?.message === ANKI_REEXPORT_HELP_MESSAGE,
    'Dummy-only collection.anki2 must show exact re-export message'
  );
  console.log('PASS: Dummy collection.anki2 triggers exact re-export guidance');

  // 4. collection.anki21b (zstd compressed) preferred over dummy collection.anki2 + skipped media count
  const modernSqlite = buildModernAnki21bSqliteBytes(sqlJs);
  const hasZstdSync = typeof (zlib as any).zstdCompressSync === 'function';
  assert.ok(hasZstdSync, 'Node 22 zlib.zstdCompressSync required to test real zstd .anki21b compression');
  const zstdAnki21b: Uint8Array = (zlib as any).zstdCompressSync(modernSqlite);

  const zstdZip = new JSZip();
  zstdZip.file('collection.anki2', dummyBytes); // Dummy older DB should be ignored!
  zstdZip.file('collection.anki21b', zstdAnki21b);
  zstdZip.file('media', JSON.stringify({ '0': 'rec1.mp3', '1': 'img.png' }));
  zstdZip.file('0', new Uint8Array([1, 2, 3]));
  zstdZip.file('1', new Uint8Array([4, 5, 6]));
  const zstdZipBytes = await zstdZip.generateAsync({ type: 'uint8array' });

  const ext21b = await extractDatabaseFromApkgZip(zstdZipBytes);
  assert.equal(ext21b.dbSource, 'collection.anki21b');
  assert.equal(ext21b.skippedMediaCount, 2);

  const inspected21b = openAndInspectAnkiDb(
    ext21b.sqliteBytes,
    sqlJs,
    ext21b.dbSource,
    ext21b.skippedMediaCount,
    ext21b.hasNewerDb
  );
  assert.equal(inspected21b.summary.totalNotes, 1);
  assert.equal(inspected21b.summary.decks[0].name, 'Japanese::Core2k');
  assert.equal(inspected21b.summary.noteTypes[0].name, 'Core 2k Japanese');

  // Stream & import into Dexie, verifying New-card reset (reps=0 despite Anki reps=15) & script/style stripping
  const sessionCtx = await createApkgWriteSession(
    {
      languageId: 'ja',
      modelMappings: {
        [inspected21b.summary.noteTypes[0].id]: inspected21b.summary.noteTypes[0].defaultMapping,
      },
      deckMode: 'keep',
      cardType: 'word_to_meaning',
      duplicateMode: 'skip',
      importAsNewOnly: true,
    },
    inspected21b.modelNameById
  );

  let createdCount = 0;
  await streamAnkiNoteBatches(inspected21b.dbConn, inspected21b.deckNameById, 100, async (batch) => {
    const r = await processApkgNoteBatch(batch, sessionCtx);
    createdCount += r.created;
  });
  inspected21b.dbConn.close();
  assert.equal(createdCount, 1);

  const importedCards = await db.cards.toArray();
  const yakusoku = importedCards.find((c) => c.word === '約束');
  assert.ok(yakusoku, '約束 card must be imported');
  assert.equal(yakusoku.reading, 'やくそく');
  assert.equal(yakusoku.meaning, 'promise\nappointment');
  assert.equal(yakusoku.notes, 'Common noun');
  assert.equal(yakusoku.sentence, '友達と約束をする。');
  assert.ok(
    yakusoku.sentenceFuriganaSegments?.some((s) => s.text === '友達' && s.ruby === 'ともだち'),
    'Sentence bracket furigana must convert to sentenceFuriganaSegments'
  );
  assert.equal(yakusoku.reps, 0, 'Scheduling must NOT be imported (New card reps=0)');
  assert.equal(yakusoku.state, 0, 'Card must start in New state (0)');
  assert.deepEqual(yakusoku.tags, ['jlpt_n5', 'core']);
  console.log('PASS: collection.anki21b zstd decompression + v18 schema + New card import + sanitization');

  // 5. Large deck test (>10,000 notes) via exported legacy .apkg -> batched import
  const now = 1760000000000;
  const bigDecks: DeckItem[] = [
    { id: 'big-d1', name: 'Bulk Deck', languageId: 'ja', createdAt: now },
  ];
  const bigCards: CardItem[] = Array.from({ length: 10200 }, (_, i) => ({
    id: `big-${i}`,
    deckId: 'big-d1',
    languageId: 'ja',
    cardType: 'word_to_meaning',
    word: `単語${i}`,
    lemma: `単語${i}`,
    reading: `たんご${i}`,
    meaning: `meaning ${i}`,
    tags: ['bulk'],
    notes: '',
    createdAt: now + i,
    updatedAt: now + i,
    suspended: false,
    buried: false,
  }));

  const bigPlan = buildAnkiExportPlan(
    bigCards,
    bigDecks,
    {
      furiganaFormat: 'both',
      useSubdeckPrefix: false,
      subdeckRootName: 'LinguaForge',
      languageName: 'Japanese',
      includeAutoLevelTag: false,
      includeAutoSourceTag: false,
      includeAutoCardTypeTag: false,
    },
    now
  );
  const { zipBytes: bigZip } = await buildAndVerifyApkg(bigPlan, sqlJs);
  const extBig = await extractDatabaseFromApkgZip(bigZip);
  const inspBig = openAndInspectAnkiDb(
    extBig.sqliteBytes,
    sqlJs,
    extBig.dbSource,
    extBig.skippedMediaCount,
    extBig.hasNewerDb
  );
  assert.equal(inspBig.summary.totalNotes, 10200);

  let streamedTotal = 0;
  let batchCount = 0;
  await streamAnkiNoteBatches(inspBig.dbConn, inspBig.deckNameById, 1000, (batch) => {
    streamedTotal += batch.length;
    batchCount += 1;
  });
  inspBig.dbConn.close();
  assert.equal(streamedTotal, 10200);
  assert.equal(batchCount, 11);
  console.log('PASS: 10,200-note .apkg streaming verified in', batchCount, 'batches');

  // 6. Backup round-trip
  const backupJson = await exportFullBackup();
  await db.cards.clear();
  await db.decks.clear();
  const restore = await restoreFromBackup(backupJson);
  assert.equal(restore.success, true);
  const afterRestore = await db.cards.toArray();
  assert.ok(afterRestore.some((c) => c.word === '約束' && c.reading === 'やくそく'));
  console.log('PASS: Backup & restore preserves imported .apkg cards and decks');

  console.log('ALL ANKI .APKG IMPORT TESTS PASSED');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
