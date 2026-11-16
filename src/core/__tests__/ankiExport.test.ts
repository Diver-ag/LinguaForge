import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import initSqlJs from 'sql.js';
import type { CardItem, DeckItem } from '../../db/db';
import {
  ANKI_SCHEMA_VERSION,
  LINGUAFORGE_VOCAB_MODEL_ID,
  ankiFieldChecksum,
  buildAnkiExportPlan,
  buildAndVerifyApkg,
  buildCsvTsvExport,
  deterministicNoteGuid,
  furiganaSegmentsToHtml,
  formatSentenceHtml,
  sanitizeAnkiTag,
  sha1Bytes,
} from '../ankiExportCore';

async function runTests() {
  console.log('--- Running Anki Export Unit & E2E Tests ---');

  // 1. SHA-1 & Anki Checksum (compare against Node crypto SHA-1)
  const digest = sha1Bytes('食べる');
  assert.equal(digest.length, 20, 'SHA-1 digest must be 20 bytes');
  const nodeSha1Hex = crypto.createHash('sha1').update('食べる', 'utf8').digest('hex');
  const ourSha1Hex = Buffer.from(digest).toString('hex');
  assert.equal(ourSha1Hex, nodeSha1Hex, 'Custom SHA-1 must match Node crypto SHA-1');
  const expectedCsum = parseInt(nodeSha1Hex.slice(0, 8), 16) >>> 0;

  const csumPlain = ankiFieldChecksum('食べる');
  const csumHtml = ankiFieldChecksum('<ruby>食<rt>た</rt></ruby>べる');
  const csumBold = ankiFieldChecksum('<b>食</b>べる');
  assert.equal(csumPlain, expectedCsum, 'Anki csum must equal first 8 hex chars of SHA-1');
  assert.equal(csumPlain, csumHtml, 'Checksum must strip HTML + ruby annotations before hashing');
  assert.equal(csumPlain, csumBold, 'Checksum must strip bold tags before hashing');
  console.log('PASS: SHA-1 & Anki checksum (matches Node crypto SHA-1:', expectedCsum, ')');

  // 2. GUID stability
  const guidA = deterministicNoteGuid('card-001');
  const guidB = deterministicNoteGuid('card-001');
  const guidC = deterministicNoteGuid('card-002');
  assert.equal(guidA, guidB, 'Same card ID must yield identical Anki GUID');
  assert.notEqual(guidA, guidC, 'Different card IDs must yield different GUIDs');
  assert.equal(guidA.length, 10, 'GUID must be 10 Base91 chars');
  console.log('PASS: Deterministic GUID stability');

  // 3. Furigana HTML & okurigana placement
  const htmlOkuri = furiganaSegmentsToHtml(
    [{ text: '食べ', ruby: 'たべ' }, { text: 'る' }],
    '食べる',
    'たべる'
  );
  assert.equal(
    htmlOkuri,
    '<ruby>食べ<rt>たべ</rt></ruby>る',
    'Okurigana should stay outside <ruby>'
  );
  const htmlFallback = furiganaSegmentsToHtml(undefined, '食べる', 'たべる');
  assert.equal(
    htmlFallback,
    '<ruby>食<rt>た</rt></ruby>べる',
    'Fallback buildFurigana should place okurigana outside <ruby>'
  );
  const highlighted = formatSentenceHtml(
    '毎日りんごを食べる。',
    undefined,
    '食べる',
    '食べる',
    false
  );
  assert.ok(
    highlighted.includes('<span class="lf-highlight">食べる</span>'),
    'Sentence HTML should wrap target word in lf-highlight'
  );
  assert.equal(sanitizeAnkiTag('JLPT N5'), 'JLPT_N5');
  console.log('PASS: Furigana HTML & tag sanitization');

  // 4. End-to-End 10-card Japanese dataset with furigana
  const now = 1760000000000;
  const decks: DeckItem[] = [
    {
      id: 'deck-ja-core',
      name: 'Core Japanese',
      languageId: 'ja',
      createdAt: now - 10000,
      description: 'Core reading vocabulary',
    },
  ];

  const sampleWords: Array<{
    word: string;
    reading: string;
    meaning: string;
    level: string;
    sentence: string;
    cardType?: CardItem['cardType'];
  }> = [
    { word: '食べる', reading: 'たべる', meaning: 'to eat', level: 'N5', sentence: '朝ごはんを食べる。' },
    { word: '飲む', reading: 'のむ', meaning: 'to drink', level: 'N5', sentence: '水を飲む。' },
    { word: '学校', reading: 'がっこう', meaning: 'school', level: 'N5', sentence: '学校に行く。' },
    { word: '図書館', reading: 'としょかん', meaning: 'library', level: 'N5', sentence: '図書館で本を読む。' },
    { word: '店員', reading: 'てんいん', meaning: 'store clerk', level: 'N4', sentence: '店員に聞く。' },
    { word: '桜', reading: 'さくら', meaning: 'cherry blossom', level: 'N3', sentence: '春に桜が咲く。' },
    { word: '約束', reading: 'やくそく', meaning: 'promise; appointment', level: 'N4', sentence: '友達と約束をする。' },
    { word: '新幹線', reading: 'しんかんせん', meaning: 'bullet train', level: 'N4', sentence: '新幹線で東京に行く。' },
    { word: '図書館', reading: 'としょかん', meaning: 'library', level: 'N5', sentence: '図書館で勉強する。', cardType: 'reading' },
    { word: '静か', reading: 'しずか', meaning: 'quiet; peaceful', level: 'N5', sentence: '夜は静かだ。', cardType: 'meaning_to_word' },
  ];

  const tenCards: CardItem[] = sampleWords.map((w, i) => ({
    id: `card-test-${i + 1}`,
    deckId: 'deck-ja-core',
    languageId: 'ja',
    cardType: w.cardType || 'word_to_meaning',
    word: w.word,
    lemma: w.word,
    reading: w.reading,
    meaning: w.meaning,
    partOfSpeech: 'noun/verb',
    level: w.level,
    frequencyBand: 'Common',
    sentence: w.sentence,
    sourceDocTitle: 'Japanese Sample Text',
    tags: ['sample list', 'reading'],
    notes: `Note for ${w.word}`,
    createdAt: now + i * 1000,
    updatedAt: now + i * 1000,
    suspended: false,
    buried: false,
  }));

  const exportOpts = {
    furiganaFormat: 'both' as const,
    useSubdeckPrefix: true,
    subdeckRootName: 'LinguaForge',
    languageName: 'Japanese',
    includeAutoLevelTag: true,
    includeAutoSourceTag: true,
    includeAutoCardTypeTag: false,
  };

  const plan1 = buildAnkiExportPlan(tenCards, decks, exportOpts, now);
  // 図書館 has both word_to_meaning and reading -> grouped into 1 note with 2 cards => 9 notes, 10 cards!
  assert.equal(plan1.notes.length, 9, 'Expected 9 grouped notes for 10 cards');
  assert.equal(plan1.cards.length, 10, 'Expected 10 Anki cards');
  assert.deepEqual(plan1.presentCardTypes, ['word_to_meaning', 'meaning_to_word', 'reading']);

  // Initialize sql.js in Node using local wasm file
  const initFn: any = typeof initSqlJs === 'function' ? initSqlJs : (initSqlJs as any).default;
  const sqlJs = await initFn({
    locateFile: () => path.resolve('public/sql-wasm.wasm'),
  });

  const { zipBytes, verification } = await buildAndVerifyApkg(plan1, sqlJs);
  assert.ok(verification.ok, `Verification failed: ${verification.error}`);
  assert.equal(verification.schemaVersion, ANKI_SCHEMA_VERSION);
  assert.equal(verification.noteCount, 9);
  assert.equal(verification.cardCount, 10);
  assert.equal(verification.revlogCount, 0);
  assert.deepEqual(verification.zipEntries, ['collection.anki2', 'media']);
  assert.equal(plan1.modelId, LINGUAFORGE_VOCAB_MODEL_ID);
  console.log('PASS: 10-card .apkg export + self-check:', JSON.stringify(verification));

  // 5. Re-export same cards -> prove identical GUIDs and note IDs
  const plan2 = buildAnkiExportPlan(tenCards, decks, exportOpts, now + 60000);
  assert.deepEqual(
    plan2.notes.map((n) => n.guid),
    plan1.notes.map((n) => n.guid),
    'Re-exporting must yield identical note GUIDs'
  );
  assert.deepEqual(
    plan2.notes.map((n) => n.nid),
    plan1.notes.map((n) => n.nid),
    'Re-exporting must yield identical note IDs'
  );
  console.log('PASS: Re-export produced 100% identical GUIDs:', plan2.notes.map((n) => n.guid));

  // 6. CSV / TSV export test
  const tsv = buildCsvTsvExport(tenCards, decks, {
    columns: ['word', 'reading', 'furiganaHtml', 'furiganaAnki', 'meaning', 'tags'],
    delimiter: '\t',
    includeHeader: false,
    includeBom: true,
    allowHtml: true,
    furiganaFormat: 'both',
    includeAutoLevelTag: true,
    includeAutoSourceTag: true,
    includeAutoCardTypeTag: false,
  });
  assert.equal(tsv.rowCount, 10);
  assert.ok(tsv.text.startsWith('\uFEFF'), 'UTF-8 BOM should be prepended');
  assert.ok(tsv.text.includes('<ruby>食<rt>た</rt></ruby>べる'), 'FuriganaHTML present in TSV');
  assert.ok(tsv.text.includes('食[た]べる'), 'FuriganaAnki present in TSV');
  assert.ok(tsv.text.includes('JLPT_N5'), 'Auto level tag present in TSV');
  console.log('PASS: CSV/TSV export with BOM + FuriganaHTML + FuriganaAnki');

  console.log('ALL ANKI EXPORT TESTS PASSED');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
