import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import path from 'node:path';
import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import { db, type CardItem, type DeckItem } from '../../db/db';
import {
  addCardsForWord,
  createClozeCardsFromCards,
  ensureDefaultDeck,
  findDuplicateClozeCard,
} from '../../db/cards';
import {
  buildClozeDuplicateKey,
  extractSentenceWithOffsets,
  formatAnkiClozeMarkup,
  formatClozeHint,
  parseAnkiClozeMarkup,
  resolveClozeFromSentence,
  validateClozeOffsets,
} from '../cloze';
import { DEFAULT_STUDY_SETTINGS } from '../studySettings';
import { answerCard, previewCardRatings, Rating, undoReview } from '../fsrsScheduler';
import {
  ANKI_SCHEMA_DDL,
  LINGUAFORGE_CLOZE_MODEL_ID,
  LINGUAFORGE_VOCAB_MODEL_ID,
  buildAnkiExportPlan,
  buildAndVerifyApkg,
} from '../ankiExportCore';
import {
  createApkgWriteSession,
  extractDatabaseFromApkgZip,
  openAndInspectAnkiDb,
  processApkgNoteBatch,
  streamAnkiNoteBatches,
} from '../ankiImportCore';
import { exportFullBackup, restoreFromBackup } from '../backup';

async function buildCustomAnkiClozeApkg(sqlJs: any): Promise<Uint8Array> {
  const ankiDb = new sqlJs.Database();
  try {
    for (const stmt of ANKI_SCHEMA_DDL) ankiDb.run(stmt);

    const clozeModelId = 1799999000111;
    const models = {
      [String(clozeModelId)]: {
        id: clozeModelId,
        name: 'Anki Cloze Builtin',
        type: 1, // Cloze
        mod: 1700000000,
        usn: -1,
        sortf: 0,
        did: 1,
        tmpls: [
          {
            name: 'Cloze',
            ord: 0,
            qfmt: '{{cloze:Text}}',
            afmt: '{{cloze:Text}}<br>{{Back Extra}}',
          },
        ],
        flds: [
          { name: 'Text', ord: 0 },
          { name: 'Back Extra', ord: 1 },
        ],
        css: '.card { font-size: 20px; }',
      },
    };
    const decks = {
      '1': { id: 1, name: 'Default' },
      '9001': { id: 9001, name: 'Cloze Study' },
    };

    ankiDb.run(
      `INSERT INTO col VALUES (1, 1700000000, 1700000000000, 1700000000000, 11, 0, 0, 0, '{}', ?, ?, '{}', '{}')`,
      [JSON.stringify(models), JSON.stringify(decks)]
    );

    const notes = [
      // 1. Supported {{c1::answer::hint}} with ruby furigana inside/outside
      {
        id: 101,
        guid: 'cloze101',
        tags: ' n4 grammar ',
        flds: [
          '<ruby>友達<rt>ともだち</rt></ruby>と{{c1::<ruby>約束<rt>やくそく</rt></ruby>::promise}}をした。',
          'Past tense context note',
        ].join('\x1f'),
      },
      // 2. Supported {{c1::answer}} without hint
      {
        id: 102,
        guid: 'cloze102',
        tags: '',
        flds: ['毎日{{c1::コーヒー}}を飲む。', 'Morning routine'].join('\x1f'),
      },
      // 3. Nested unsupported cloze -> must fail & report cleanly
      {
        id: 103,
        guid: 'cloze103',
        tags: '',
        flds: ['これは{{c1::外側の{{c2::内側}}}}のテスト。', 'Nested'].join('\x1f'),
      },
      // 4. Multiple cloze numbers c1 & c2 -> imports primary & emits warning
      {
        id: 104,
        guid: 'cloze104',
        tags: '',
        flds: ['{{c1::昨日}}は{{c2::図書館}}に行った。', 'Multi blank'].join('\x1f'),
      },
    ];

    notes.forEach((n, idx) => {
      ankiDb.run(
        `INSERT INTO notes VALUES (?, ?, ?, 1700000000, -1, ?, ?, ?, ?, 0, '')`,
        [n.id, n.guid, clozeModelId, n.tags, n.flds, `sfld${idx}`, 100 + idx]
      );
      ankiDb.run(
        `INSERT INTO cards VALUES (?, ?, 9001, 0, 1700000000, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '{}')`,
        [200 + idx, n.id, idx + 1]
      );
    });

    const sqliteBytes = ankiDb.export();
    const zip = new JSZip();
    zip.file('collection.anki2', sqliteBytes);
    zip.file('media', '{}');
    return await zip.generateAsync({ type: 'uint8array' });
  } finally {
    ankiDb.close();
  }
}

async function runTests() {
  console.log('--- Running Phase 2E-3 Cloze Cards Tests ---');

  await db.delete();
  await db.open();
  await ensureDefaultDeck('ja');

  // 1. Offset extraction on repeated occurrences & conjugated forms
  const textWithRepeats = '店員が店にいる。\n明日も店へ行く。';
  // First sentence: "店員が店にいる。" -> index 0 is '店' (店員), index 3 is '店' (店にいる)
  const firstTen = extractSentenceWithOffsets(textWithRepeats, 0, 1);
  assert.ok(firstTen);
  assert.equal(firstTen.sentence, '店員が店にいる。');
  assert.equal(firstTen.start, 0);
  assert.equal(firstTen.end, 1);
  assert.equal(firstTen.sentence.slice(firstTen.start, firstTen.end), '店');

  const secondMise = extractSentenceWithOffsets(textWithRepeats, 3, 4);
  assert.ok(secondMise);
  assert.equal(secondMise.sentence, '店員が店にいる。');
  assert.equal(secondMise.start, 3);
  assert.equal(secondMise.end, 4);
  assert.equal(secondMise.sentence.slice(secondMise.start, secondMise.end), '店');

  // Conjugated form in second line with leading whitespace/newline
  const conjugatedText = '  今日は寿司を食べた！\n明日も食べる。';
  const conjStart = conjugatedText.indexOf('食べた');
  const conjExtracted = extractSentenceWithOffsets(
    conjugatedText,
    conjStart,
    conjStart + '食べた'.length
  );
  assert.ok(conjExtracted);
  assert.equal(conjExtracted.sentence, '今日は寿司を食べた！');
  assert.equal(
    conjExtracted.sentence.slice(conjExtracted.start, conjExtracted.end),
    '食べた'
  );
  console.log('PASS: Exact token offsets preserve repeated occurrences and conjugated forms');

  // 2. Hint formatting & validation
  const clozeSampleCard = {
    meaning: 'to eat',
    reading: 'たべる',
    cloze: {
      sentence: '今日は寿司を食べた！',
      start: 6,
      end: 9,
      answer: '食べた',
      lemma: '食べる',
      reading: 'たべる',
      hint: 'to eat (past)',
    },
  };
  assert.equal(formatClozeHint(clozeSampleCard, 'meaning'), 'to eat (past)');
  assert.equal(formatClozeHint(clozeSampleCard, 'reading'), 'たべる');
  assert.equal(formatClozeHint(clozeSampleCard, 'both'), 'to eat (past) · たべる');
  assert.equal(formatClozeHint(clozeSampleCard, 'none'), '');

  assert.deepEqual(validateClozeOffsets('今日は寿司を食べた！', 6, 9, '食べた'), {
    valid: true,
    slice: '食べた',
    mismatch: false,
  });
  assert.deepEqual(validateClozeOffsets('今日は寿司を残した！', 6, 9, '食べた'), {
    valid: true,
    slice: '残した',
    mismatch: true,
  });
  console.log('PASS: Cloze hint modes & offset validation');

  // 3. Duplicate prevention by (lemma + sentence + start + end) & multiple distinct blanks allowed
  const firstAdd = await addCardsForWord({
    languageId: 'ja',
    cardTypes: ['word_to_meaning', 'cloze'],
    word: '食べた',
    lemma: '食べる',
    reading: 'たべる',
    meaning: 'to eat',
    sentence: '今日は寿司を食べた！',
    cloze: {
      sentence: '今日は寿司を食べた！',
      start: 6,
      end: 9,
      answer: '食べた',
      lemma: '食べる',
      reading: 'たべる',
      hint: 'to eat',
    },
  });
  assert.equal(firstAdd.added.length, 2);
  assert.equal(firstAdd.duplicateTypes.length, 0);

  // Exact duplicate cloze rejected
  const dupAdd = await addCardsForWord({
    languageId: 'ja',
    cardTypes: ['cloze'],
    word: '食べた',
    lemma: '食べる',
    reading: 'たべる',
    meaning: 'to eat',
    sentence: '今日は寿司を食べた！',
    cloze: {
      sentence: '今日は寿司を食べた！',
      start: 6,
      end: 9,
      answer: '食べた',
      lemma: '食べる',
      reading: 'たべる',
      hint: 'to eat',
    },
  });
  assert.equal(dupAdd.added.length, 0);
  assert.deepEqual(dupAdd.duplicateTypes, ['cloze']);

  // Different sentence with same lemma IS allowed
  const otherSentenceAdd = await addCardsForWord({
    languageId: 'ja',
    cardTypes: ['cloze'],
    word: '食べる',
    lemma: '食べる',
    reading: 'たべる',
    meaning: 'to eat',
    sentence: '朝ごはんを食べる。',
    cloze: {
      sentence: '朝ごはんを食べる。',
      start: 5,
      end: 8,
      answer: '食べる',
      lemma: '食べる',
      reading: 'たべる',
      hint: 'to eat',
    },
  });
  assert.equal(otherSentenceAdd.added.length, 1);
  assert.ok(
    await findDuplicateClozeCard({
      languageId: 'ja',
      lemma: '食べる',
      sentence: '朝ごはんを食べる。',
      start: 5,
      end: 8,
    })
  );
  console.log('PASS: Cloze duplicate detection allows distinct sentences & blocks exact dupes');

  // 4. Bulk createClozeCardsFromCards with tokenizer matching conjugated forms
  const vocabCard = firstAdd.added.find((c) => c.cardType === 'word_to_meaning')!;
  const newVocabForBulk = await addCardsForWord({
    languageId: 'ja',
    cardTypes: ['word_to_meaning'],
    word: '飲む',
    lemma: '飲む',
    reading: 'のむ',
    meaning: 'to drink',
    sentence: '冷たい水を飲んだ。',
  });
  const noSentenceVocab = await addCardsForWord({
    languageId: 'ja',
    cardTypes: ['word_to_meaning'],
    word: '山',
    lemma: '山',
    reading: 'やま',
    meaning: 'mountain',
    sentence: '',
  });
  const bulkRes = await createClozeCardsFromCards(
    [vocabCard.id, newVocabForBulk.added[0].id, noSentenceVocab.added[0].id],
    async (sentence) => {
      if (sentence === '冷たい水を飲んだ。') {
        const idx = sentence.indexOf('飲んだ');
        return [
          {
            surface: '飲んだ',
            lemma: '飲む',
            reading: 'のむ',
            startIndex: idx,
            endIndex: idx + 3,
          },
        ];
      }
      return [];
    }
  );
  assert.equal(bulkRes.created.length, 1);
  assert.equal(bulkRes.created[0].cloze?.answer, '飲んだ');
  assert.equal(bulkRes.created[0].cloze?.lemma, '飲む');
  assert.equal(bulkRes.skippedDuplicate, 1);
  assert.equal(bulkRes.skippedNoSentence, 1);
  console.log('PASS: Bulk cloze creation resolves conjugated surfaces & skips dupes/empty sentences');

  // 5. FSRS scheduling & Undo on Cloze cards
  const clozeCard = firstAdd.added.find((c) => c.cardType === 'cloze')!;
  const now = new Date(1760000000000);
  const previews = await previewCardRatings(clozeCard, DEFAULT_STUDY_SETTINGS, now);
  assert.equal(previews.length, 4);
  const ans = await answerCard({
    card: clozeCard,
    rating: Rating.Good,
    elapsedMs: 2400,
    settings: DEFAULT_STUDY_SETTINGS,
    now,
  });
  assert.equal(ans.updatedCard.cardType, 'cloze');
  assert.equal(ans.updatedCard.reps, 1);
  assert.ok(typeof ans.updatedCard.due === 'number' && ans.updatedCard.due > now.getTime());
  assert.equal(ans.reviewLog.cardId, clozeCard.id);

  const restoredFromUndo = await undoReview({
    previousSnapshot: ans.previousSnapshot,
    reviewLogId: ans.reviewLog.id,
  });
  assert.equal(restoredFromUndo.reps, 0);
  console.log('PASS: FSRS scheduling + Undo works on cloze cards');

  // 6. .apkg Cloze Export + Vocab-Only Isolation
  const initFn: any = typeof initSqlJs === 'function' ? initSqlJs : (initSqlJs as any).default;
  const sqlJs = await initFn({
    locateFile: () => path.resolve('public/sql-wasm.wasm'),
  });

  const jaDecks = await db.decks.where('languageId').equals('ja').toArray();
  const allCards = await db.cards.toArray();
  const vocabOnlyCards = allCards.filter((c) => c.cardType !== 'cloze');
  const exportOpts = {
    furiganaFormat: 'both' as const,
    useSubdeckPrefix: false,
    subdeckRootName: 'LinguaForge',
    languageName: 'Japanese',
    includeAutoLevelTag: true,
    includeAutoSourceTag: true,
    includeAutoCardTypeTag: true,
  };

  // Vocab-only export MUST NOT emit LinguaForge Cloze model
  const vocabPlan = buildAnkiExportPlan(vocabOnlyCards, jaDecks, exportOpts, 1760000000000);
  assert.equal(vocabPlan.hasClozeCards, false);
  const vocabVerified = await buildAndVerifyApkg(vocabPlan, sqlJs);
  assert.equal(vocabVerified.verification.ok, true);
  const vocabExt = await extractDatabaseFromApkgZip(vocabVerified.zipBytes);
  const vocabCheckDb = new sqlJs.Database(vocabExt.sqliteBytes);
  const vocabModels = JSON.parse(String(vocabCheckDb.exec('SELECT models FROM col;')[0].values[0][0]));
  vocabCheckDb.close();
  assert.ok(
    !vocabModels[String(LINGUAFORGE_CLOZE_MODEL_ID)],
    'Vocab-only export must NOT alter col.models with Cloze model'
  );
  assert.ok(vocabModels[String(LINGUAFORGE_VOCAB_MODEL_ID)]);

  // Mixed export (Vocab + Cloze) emits LinguaForge Cloze model with type=1 & {{c1::...}}
  const mixedPlan = buildAnkiExportPlan(allCards, jaDecks, exportOpts, 1760000000000);
  assert.equal(mixedPlan.hasClozeCards, true);
  const mixedVerified = await buildAndVerifyApkg(mixedPlan, sqlJs);
  assert.equal(mixedVerified.verification.ok, true);
  const mixedExt = await extractDatabaseFromApkgZip(mixedVerified.zipBytes);
  const mixedCheckDb = new sqlJs.Database(mixedExt.sqliteBytes);
  const mixedModels = JSON.parse(String(mixedCheckDb.exec('SELECT models FROM col;')[0].values[0][0]));
  mixedCheckDb.close();
  const clozeModelObj = mixedModels[String(LINGUAFORGE_CLOZE_MODEL_ID)];
  assert.ok(clozeModelObj, 'Mixed export must include LinguaForge Cloze model');
  assert.equal(clozeModelObj.type, 1, 'Anki Cloze model must have type === 1');
  const clozeNotes = mixedPlan.notes.filter((n) => n.mid === LINGUAFORGE_CLOZE_MODEL_ID);
  assert.equal(clozeNotes.length, 3);
  assert.ok(clozeNotes.some((n) => n.fields[0] === '今日は寿司を{{c1::食べた::to eat}}！'));
  console.log('PASS: .apkg Cloze export + vocab-only model isolation verified');

  // 7. Round-trip import of LinguaForge Cloze .apkg export back into empty DB
  await db.cards.clear();
  const roundTripExt = await extractDatabaseFromApkgZip(mixedVerified.zipBytes);
  const roundTripInsp = openAndInspectAnkiDb(
    roundTripExt.sqliteBytes,
    sqlJs,
    roundTripExt.dbSource,
    roundTripExt.skippedMediaCount,
    roundTripExt.hasNewerDb
  );
  const clozeModelInfo = roundTripInsp.summary.noteTypes.find(
    (nt) => nt.id === String(LINGUAFORGE_CLOZE_MODEL_ID)
  );
  assert.ok(clozeModelInfo);
  assert.equal(clozeModelInfo.isClozeModel, true);

  const roundTripSession = await createApkgWriteSession(
    {
      languageId: 'ja',
      modelMappings: Object.fromEntries(
        roundTripInsp.summary.noteTypes.map((nt) => [nt.id, nt.defaultMapping])
      ),
      deckMode: 'keep',
      cardType: 'word_to_meaning',
      duplicateMode: 'skip',
      importAsNewOnly: true,
    },
    roundTripInsp.modelNameById,
    roundTripInsp.modelIsClozeById,
    roundTripInsp.modelFieldNamesById
  );

  let rtClozeCreated = 0;
  await streamAnkiNoteBatches(
    roundTripInsp.dbConn,
    roundTripInsp.deckNameById,
    100,
    async (batch) => {
      const stats = await processApkgNoteBatch(batch, roundTripSession);
      rtClozeCreated += stats.clozeCreated;
    }
  );
  roundTripInsp.dbConn.close();
  assert.equal(rtClozeCreated, 3);
  const rtCards = await db.cards.toArray();
  const rtTabeta = rtCards.find(
    (c) => c.cardType === 'cloze' && c.cloze?.answer === '食べた'
  );
  assert.ok(rtTabeta);
  assert.equal(rtTabeta.cloze?.sentence, '今日は寿司を食べた！');
  assert.equal(rtTabeta.cloze?.start, 6);
  assert.equal(rtTabeta.cloze?.end, 9);
  assert.equal(rtTabeta.cloze?.hint, 'to eat');
  console.log('PASS: LinguaForge Cloze .apkg round-trip export -> import verified');

  // 8. Custom Anki Cloze .apkg import: {{c1::answer::hint}}, {{c1::answer}}, nested error & c2 warning
  await db.cards.clear();
  const customClozeApkg = await buildCustomAnkiClozeApkg(sqlJs);
  const customExt = await extractDatabaseFromApkgZip(customClozeApkg);
  const customInsp = openAndInspectAnkiDb(
    customExt.sqliteBytes,
    sqlJs,
    customExt.dbSource,
    customExt.skippedMediaCount,
    customExt.hasNewerDb
  );
  assert.equal(customInsp.summary.noteTypes[0].isClozeModel, true);
  assert.deepEqual(customInsp.summary.noteTypes[0].defaultMapping, ['sentence', 'notes']);

  const customSession = await createApkgWriteSession(
    {
      languageId: 'ja',
      modelMappings: {
        [customInsp.summary.noteTypes[0].id]: customInsp.summary.noteTypes[0].defaultMapping,
      },
      deckMode: 'keep',
      cardType: 'word_to_meaning',
      duplicateMode: 'skip',
      importAsNewOnly: true,
    },
    customInsp.modelNameById,
    customInsp.modelIsClozeById,
    customInsp.modelFieldNamesById
  );

  let customClozeCreated = 0;
  let customUnsupported = 0;
  const customWarnings: string[] = [];
  const customFailed: any[] = [];
  await streamAnkiNoteBatches(
    customInsp.dbConn,
    customInsp.deckNameById,
    100,
    async (batch) => {
      const stats = await processApkgNoteBatch(batch, customSession);
      customClozeCreated += stats.clozeCreated;
      customUnsupported += stats.unsupportedClozeCount;
      customWarnings.push(...stats.clozeWarnings);
      customFailed.push(...stats.failed);
    }
  );
  customInsp.dbConn.close();

  assert.equal(customClozeCreated, 3, 'Should import 2 single-cloze + 1 primary-collapsed multi-cloze');
  assert.equal(customUnsupported, 1, 'Nested cloze note must be rejected as unsupported');
  assert.equal(customFailed.length, 1);
  assert.ok(customFailed[0].reason.includes('Nested'));
  assert.equal(customWarnings.length, 1);
  assert.ok(customWarnings[0].includes('c1, c2'));

  const customImportedCards = await db.cards.toArray();
  const yakusokuCloze = customImportedCards.find((c) => c.cloze?.answer === '約束');
  assert.ok(yakusokuCloze);
  assert.equal(yakusokuCloze.cloze?.sentence, '友達と約束をした。');
  assert.equal(yakusokuCloze.cloze?.hint, 'promise');
  assert.ok(
    yakusokuCloze.sentenceFuriganaSegments?.some((s) => s.text === '約束' && s.ruby === 'やくそく'),
    'Ruby tags inside/around {{c1::...}} must convert to sentenceFuriganaSegments'
  );
  const coffeeCloze = customImportedCards.find((c) => c.cloze?.answer === 'コーヒー');
  assert.ok(coffeeCloze);
  assert.equal(coffeeCloze.cloze?.sentence, '毎日コーヒーを飲む。');
  assert.equal(coffeeCloze.cloze?.hint, '');
  console.log('PASS: Anki Cloze import ({{c1::...::...}}, <ruby>, nested rejection & multi-cloze warnings)');

  // 9. Backup & Restore preserves Cloze fields
  const backupJson = await exportFullBackup();
  await db.cards.clear();
  const restoreRes = await restoreFromBackup(backupJson);
  assert.equal(restoreRes.success, true);
  const afterRestore = await db.cards.toArray();
  const restoredYakusoku = afterRestore.find((c) => c.cloze?.answer === '約束');
  assert.ok(restoredYakusoku);
  assert.equal(restoredYakusoku.cloze?.sentence.slice(restoredYakusoku.cloze.start, restoredYakusoku.cloze.end), '約束');
  assert.equal(restoredYakusoku.cloze?.start, 3);
  assert.equal(restoredYakusoku.cloze?.end, 5);
  assert.equal(restoredYakusoku.cloze?.hint, 'promise');
  console.log('PASS: Full backup & restore preserves structured cloze cards');

  console.log('ALL PHASE 2E-3 CLOZE TESTS PASSED');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
