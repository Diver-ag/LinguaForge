import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { db } from '../../db/db';
import {
  addCardsForWord,
  createListeningCardsFromCards,
  ensureDefaultDeck,
  findDuplicateCard,
} from '../../db/cards';
import {
  chunkSpeechText,
  formatAnkiTtsTag,
  getVoicesForLanguage,
  selectVoiceForSpeech,
  type SpeechVoiceOption,
} from '../speech';
import { DEFAULT_STUDY_SETTINGS, normalizeStudySettings } from '../studySettings';
import { answerCard, previewCardRatings, Rating, undoReview } from '../fsrsScheduler';
import {
  LINGUAFORGE_CLOZE_MODEL_ID,
  LINGUAFORGE_LISTENING_MODEL_ID,
  LINGUAFORGE_VOCAB_MODEL_ID,
  buildAnkiExportPlan,
  buildAndVerifyApkg,
} from '../ankiExportCore';
import { extractDatabaseFromApkgZip } from '../ankiImportCore';
import { computeDashboardStats } from '../statsEngine';
import { exportFullBackup, restoreFromBackup } from '../backup';

function mockVoice(
  name: string,
  lang: string,
  localService: boolean,
  isDefault = false
): SpeechVoiceOption {
  const voiceURI = `${name}::${lang}`;
  return {
    voiceURI,
    name,
    lang,
    localService,
    isDefault,
    voice: {
      voiceURI,
      name,
      lang,
      localService,
      default: isDefault,
    } as SpeechSynthesisVoice,
  };
}

async function runTests() {
  console.log('--- Running Phase 2E-4 Listening Cards Tests ---');

  // 1. Voice language matching & offline local-voice preference
  const voices: SpeechVoiceOption[] = [
    mockVoice('Google 日本語', 'ja-JP', false, true),
    mockVoice('Kyoko', 'ja-JP', true, false),
    mockVoice('O-Ren', 'ja_JP', true, false),
    mockVoice('Monica', 'es-ES', true, false),
    mockVoice('Google English', 'en-US', false, false),
  ];

  const jaVoices = getVoicesForLanguage(voices, 'ja-JP');
  assert.equal(jaVoices.length, 3);
  // Local voices sort ahead of network voice
  assert.equal(jaVoices[0].localService, true);
  assert.equal(jaVoices[1].localService, true);
  assert.equal(jaVoices[2].name, 'Google 日本語');

  // Online uses preferred network voice if selected
  const onlinePref = selectVoiceForSpeech({
    voices,
    ttsCode: 'ja-JP',
    preferredVoiceId: 'Google 日本語::ja-JP',
    isOnline: true,
  });
  assert.equal(onlinePref.offlineBlocked, false);
  assert.equal(onlinePref.voice?.name, 'Google 日本語');

  // Offline falls back to local voice when preferred voice is network-only
  const offlineFallback = selectVoiceForSpeech({
    voices,
    ttsCode: 'ja-JP',
    preferredVoiceId: 'Google 日本語::ja-JP',
    isOnline: false,
  });
  assert.equal(offlineFallback.offlineBlocked, false);
  assert.equal(offlineFallback.usedLocalFallback, true);
  assert.equal(offlineFallback.voice?.localService, true);

  // Offline blocks clearly when only network voices exist for a language
  const enNetworkOnly = selectVoiceForSpeech({
    voices,
    ttsCode: 'en-US',
    isOnline: false,
  });
  assert.equal(enNetworkOnly.offlineBlocked, true);
  assert.equal(enNetworkOnly.voice, null);
  assert.ok(enNetworkOnly.reason?.toLowerCase().includes('network'));

  // Missing language voice returns clear reason
  const missingFr = selectVoiceForSpeech({
    voices,
    ttsCode: 'fr-FR',
    isOnline: true,
  });
  assert.equal(missingFr.voice, null);
  assert.equal(missingFr.offlineBlocked, false);
  assert.ok(missingFr.reason?.includes('fr-FR'));
  console.log('PASS: Voice language matching, offline local fallback, and network-only warnings');

  // 2. Speech chunking & Anki TTS tag formatting & study settings normalization
  assert.deepEqual(chunkSpeechText('食べる', 150), ['食べる']);
  const longText =
    '今日は朝からいい天気ですね。公園を散歩して、美味しいコーヒーを飲みました。' +
    'それから図書館で日本語の本を三冊借りました。明日は友達と映画を見に行く予定です。' +
    'とても楽しみにしています。週末には家族と美味しい晩ご飯も作りたいと思います。';
  const chunks = chunkSpeechText(longText, 70);
  assert.ok(chunks.length >= 2);
  for (const ch of chunks) {
    assert.ok(ch.length <= 70, `Chunk exceeded maxLen: ${ch.length}`);
  }
  assert.equal(chunks.join(''), longText);

  assert.equal(formatAnkiTtsTag('ja-JP', 'AudioText'), '{{tts ja_JP:AudioText}}');
  assert.equal(formatAnkiTtsTag('es-ES', 'AudioText'), '{{tts es_ES:AudioText}}');

  const normSettings = normalizeStudySettings({
    speechVoiceByLang: { ja: 'Kyoko::ja-JP', 'ja-JP': 'Kyoko::ja-JP' },
    speechRate: 0.85,
    listeningAutoPlay: false,
  });
  assert.equal(normSettings.speechVoiceByLang.ja, 'Kyoko::ja-JP');
  assert.equal(normSettings.speechRate, 0.85);
  assert.equal(normSettings.listeningAutoPlay, false);
  console.log('PASS: Speech text chunking, Anki {{tts}} formatting, and Speech settings normalization');

  // 3. Database: create listening cards, duplicate guard, bulk create
  await db.delete();
  await db.open();
  await ensureDefaultDeck('ja');

  const addedRes = await addCardsForWord({
    languageId: 'ja',
    cardTypes: ['word_to_meaning', 'listening'],
    word: '図書館',
    lemma: '図書館',
    reading: 'としょかん',
    meaning: 'library',
    sentence: '毎日図書館で勉強します。',
    listeningTarget: 'sentence',
    level: 'N5',
    sourceDocTitle: 'Daily Diary',
  });
  assert.equal(addedRes.added.length, 2);
  const listeningCard1 = addedRes.added.find((c) => c.cardType === 'listening')!;
  assert.ok(listeningCard1);
  assert.equal(listeningCard1.listeningTarget, 'sentence');

  // Exact duplicate listening card must be rejected
  const dupRes = await addCardsForWord({
    languageId: 'ja',
    cardTypes: ['listening'],
    word: '図書館',
    lemma: '図書館',
    reading: 'としょかん',
    meaning: 'library',
    sentence: '毎日図書館で勉強します。',
  });
  assert.equal(dupRes.added.length, 0);
  assert.deepEqual(dupRes.duplicateTypes, ['listening']);
  assert.ok(
    await findDuplicateCard({
      languageId: 'ja',
      lemma: '図書館',
      reading: 'としょかん',
      cardType: 'listening',
    })
  );

  // Bulk create listening cards from existing vocab cards (skips existing 図書館, creates 電車)
  const vocabCard1 = addedRes.added.find((c) => c.cardType === 'word_to_meaning')!;
  const vocabCard2 = await addCardsForWord({
    languageId: 'ja',
    cardTypes: ['word_to_meaning'],
    word: '電車',
    lemma: '電車',
    reading: 'でんしゃ',
    meaning: 'train',
    sentence: '電車に乗る。',
    level: 'N5',
  });
  const bulkRes = await createListeningCardsFromCards(
    [vocabCard1.id, vocabCard2.added[0].id],
    'word'
  );
  assert.equal(bulkRes.created.length, 1);
  assert.equal(bulkRes.skippedDuplicate, 1);
  assert.equal(bulkRes.created[0].word, '電車');
  assert.equal(bulkRes.created[0].listeningTarget, 'word');
  console.log('PASS: Listening card creation, duplicate detection, and bulk create');

  // 4. FSRS scheduling + Undo on listening card
  const now = new Date(1760000000000);
  const previews = await previewCardRatings(listeningCard1, DEFAULT_STUDY_SETTINGS, now);
  assert.equal(previews.length, 4);
  const graded = await answerCard({
    card: listeningCard1,
    rating: Rating.Good,
    elapsedMs: 1800,
    settings: DEFAULT_STUDY_SETTINGS,
    now,
  });
  assert.equal(graded.updatedCard.cardType, 'listening');
  assert.equal(graded.updatedCard.reps, 1);
  assert.ok((graded.updatedCard.due ?? 0) > now.getTime());

  // Stats breakdown includes listening
  const statsData = await computeDashboardStats({
    languageId: 'ja',
    deckId: 'all',
    cardType: 'all',
    period: 'all',
    includeDemoData: false,
    studySettings: DEFAULT_STUDY_SETTINGS,
    nowMs: now.getTime() + 1000,
  });
  const listeningBreakdown = statsData.cardTypeBreakdown.find((b) => b.cardType === 'listening');
  assert.ok(listeningBreakdown);
  assert.equal(listeningBreakdown.totalCards, 2);
  assert.equal(listeningBreakdown.reviews, 1);

  const undone = await undoReview({
    previousSnapshot: graded.previousSnapshot,
    reviewLogId: graded.reviewLog.id,
  });
  assert.equal(undone.reps, 0);
  console.log('PASS: FSRS scheduling, Undo, and Stats breakdown for listening cards');

  // 5. .apkg Listening export & Vocab-only isolation
  const initFn: any = typeof initSqlJs === 'function' ? initSqlJs : (initSqlJs as any).default;
  const sqlJs = await initFn({
    locateFile: () => path.resolve('public/sql-wasm.wasm'),
  });

  const jaDecks = await db.decks.where('languageId').equals('ja').toArray();
  const allCards = await db.cards.toArray();
  const vocabOnly = allCards.filter((c) => c.cardType !== 'listening');
  const exportOpts = {
    furiganaFormat: 'both' as const,
    useSubdeckPrefix: false,
    subdeckRootName: 'LinguaForge',
    languageName: 'Japanese',
    ttsLangCode: 'ja-JP',
    includeAutoLevelTag: true,
    includeAutoSourceTag: true,
    includeAutoCardTypeTag: true,
  };

  // Vocab-only export must NOT contain LinguaForge Listening model
  const vocabPlan = buildAnkiExportPlan(vocabOnly, jaDecks, exportOpts, 1760000000000);
  assert.equal(vocabPlan.hasListeningCards, false);
  const vocabBuilt = await buildAndVerifyApkg(vocabPlan, sqlJs);
  assert.equal(vocabBuilt.verification.ok, true);
  const vocabExt = await extractDatabaseFromApkgZip(vocabBuilt.zipBytes);
  const vocabCheckDb = new sqlJs.Database(vocabExt.sqliteBytes);
  const vocabModels = JSON.parse(String(vocabCheckDb.exec('SELECT models FROM col;')[0].values[0][0]));
  vocabCheckDb.close();
  assert.ok(vocabModels[String(LINGUAFORGE_VOCAB_MODEL_ID)]);
  assert.ok(!vocabModels[String(LINGUAFORGE_LISTENING_MODEL_ID)]);
  assert.ok(!vocabModels[String(LINGUAFORGE_CLOZE_MODEL_ID)]);

  // Mixed export with listening cards emits LinguaForge Listening model with {{tts ja_JP:AudioText}}
  const mixedPlan = buildAnkiExportPlan(allCards, jaDecks, exportOpts, 1760000000000);
  assert.equal(mixedPlan.hasListeningCards, true);
  assert.equal(mixedPlan.listeningModelId, LINGUAFORGE_LISTENING_MODEL_ID);
  const listeningNotes = mixedPlan.notes.filter((n) => n.mid === LINGUAFORGE_LISTENING_MODEL_ID);
  assert.equal(listeningNotes.length, 2);
  // Sentence target exports sentence in AudioText; Word target exports word in AudioText
  assert.ok(listeningNotes.some((n) => n.fields[0] === '毎日図書館で勉強します。'));
  assert.ok(listeningNotes.some((n) => n.fields[0] === '電車'));

  const mixedBuilt = await buildAndVerifyApkg(mixedPlan, sqlJs);
  assert.equal(mixedBuilt.verification.ok, true);
  const mixedExt = await extractDatabaseFromApkgZip(mixedBuilt.zipBytes);
  const mixedCheckDb = new sqlJs.Database(mixedExt.sqliteBytes);
  const mixedModels = JSON.parse(String(mixedCheckDb.exec('SELECT models FROM col;')[0].values[0][0]));
  mixedCheckDb.close();
  const listeningModel = mixedModels[String(LINGUAFORGE_LISTENING_MODEL_ID)];
  assert.ok(listeningModel, 'LinguaForge Listening model must exist in col.models');
  const qfmt: string = listeningModel.tmpls[0].qfmt;
  const afmt: string = listeningModel.tmpls[0].afmt;
  assert.ok(qfmt.includes('{{tts ja_JP:AudioText}}'), 'Front template must use Anki {{tts}} syntax');
  assert.ok(!qfmt.includes('{{Word}}') && !qfmt.includes('{{Meaning}}') && !qfmt.includes('{{Sentence}}'), 'Front template must not reveal target text');
  assert.ok(afmt.includes('{{Word}}') && afmt.includes('{{Meaning}}') && afmt.includes('{{Reading}}'));
  console.log('PASS: .apkg Listening export ({{tts ja_JP:AudioText}}) & vocab-only model isolation');

  // 6. Backup & Restore preserves listeningTarget
  const backupJson = await exportFullBackup();
  await db.cards.clear();
  const restoreRes = await restoreFromBackup(backupJson);
  assert.equal(restoreRes.success, true);
  const restoredCards = await db.cards.toArray();
  const restoredSentenceListening = restoredCards.find(
    (c) => c.cardType === 'listening' && c.word === '図書館'
  );
  const restoredWordListening = restoredCards.find(
    (c) => c.cardType === 'listening' && c.word === '電車'
  );
  assert.equal(restoredSentenceListening?.listeningTarget, 'sentence');
  assert.equal(restoredWordListening?.listeningTarget, 'word');
  console.log('PASS: Backup & restore preserves listening cards and listeningTarget');

  console.log('ALL PHASE 2E-4 LISTENING TESTS PASSED');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
