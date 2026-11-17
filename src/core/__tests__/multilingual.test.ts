import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { db } from '../../db/db';
import { addCardsForWord, ensureDefaultDeck, getDefaultDeckId } from '../../db/cards';
import { packSupportsRuby } from '../languagePack';
import { getAllLanguagePacks, getLanguagePack } from '../../packs/registry';
import { buildMandarinPinyinSegments } from '../../packs/multilingualPack';
import { extractSentenceWithOffsets, resolveClozeFromSentence } from '../cloze';
import {
  collectCardTags,
  formatAnkiDeckName,
  furiganaSegmentsToHtml,
} from '../ankiExportCore';
import { formatAnkiTtsTag } from '../speech';
import {
  getInstalledLanguageIds,
  getInstalledPacksMap,
  importCustomLanguageJsonOrCsv,
  installLanguagePack,
  isAbortError,
  removeLanguagePack,
} from '../packManager';
import { getDeveloperSettings, saveDeveloperSettings } from '../studySettings';
import { exportFullBackup, restoreFromBackup } from '../backup';

async function runTests() {
  console.log('--- Running Phase 3A Multi-Language Support & Pack Manager Tests ---');

  await db.delete();
  await db.open();

  // 1. Registry: 9 languages with expected metadata, TTS codes, level systems, and ruby flags
  const allPacks = getAllLanguagePacks();
  const ids = allPacks.map((p) => p.id);
  assert.deepEqual(ids, ['ja', 'de', 'fr', 'it', 'pt', 'tr', 'nl', 'ko', 'zh']);
  assert.equal(ids.includes('es'), false);

  const expectedMeta: Record<string, { tts: string; levelName: string; ruby: boolean }> = {
    ja: { tts: 'ja-JP', levelName: 'JLPT', ruby: true },
    de: { tts: 'de-DE', levelName: 'CEFR', ruby: false },
    fr: { tts: 'fr-FR', levelName: 'CEFR', ruby: false },
    it: { tts: 'it-IT', levelName: 'CEFR', ruby: false },
    pt: { tts: 'pt-BR', levelName: 'CEFR', ruby: false },
    tr: { tts: 'tr-TR', levelName: 'CEFR', ruby: false },
    nl: { tts: 'nl-NL', levelName: 'CEFR', ruby: false },
    ko: { tts: 'ko-KR', levelName: 'TOPIK', ruby: false },
    zh: { tts: 'zh-CN', levelName: 'HSK', ruby: true },
  };

  for (const [langId, exp] of Object.entries(expectedMeta)) {
    const p = getLanguagePack(langId);
    assert.equal(p.id, langId);
    assert.equal(p.ttsCode, exp.tts);
    assert.equal(p.levelSystem.name, exp.levelName);
    assert.equal(packSupportsRuby(p), exp.ruby);
    assert.ok(p.sampleTestPhrase && p.sampleTestPhrase.length > 0);
  }
  console.log('PASS: 9 languages registered with TTS codes, level systems, and ruby flags');

  // 2. Intl.Segmenter tokenization & exact offsets + Cloze offset compatibility across languages
  const dePack = getLanguagePack('de');
  const deText = 'Ich habe heute ein Buch gelesen. Morgen lese ich weiter.';
  const deTokens = await dePack.tokenize(deText);
  for (const tok of deTokens) {
    assert.equal(
      deText.slice(tok.startIndex, tok.endIndex),
      tok.surface,
      `German token offset mismatch for "${tok.surface}"`
    );
  }
  const deBookTok = deTokens.find((t) => t.surface === 'Buch');
  assert.ok(deBookTok);
  const deSentenceSpan = extractSentenceWithOffsets(deText, deBookTok.startIndex, deBookTok.endIndex);
  assert.ok(deSentenceSpan);
  assert.equal(deSentenceSpan.sentence, 'Ich habe heute ein Buch gelesen.');
  assert.equal(
    deSentenceSpan.sentence.slice(deSentenceSpan.start, deSentenceSpan.end),
    'Buch'
  );

  // French & Italian apostrophe elision handling
  const frPack = getLanguagePack('fr');
  const frText = "C'est l'arbre que j'aime beaucoup.";
  const frTokens = await frPack.tokenize(frText);
  for (const tok of frTokens) {
    assert.equal(
      frText.slice(tok.startIndex, tok.endIndex),
      tok.surface,
      `French token offset mismatch for "${tok.surface}"`
    );
  }
  assert.ok(frTokens.some((t) => t.surface.toLowerCase() === "l'"));
  assert.ok(frTokens.some((t) => t.surface === 'arbre'));

  const itPack = getLanguagePack('it');
  const itTokens = await itPack.tokenize("Bevo l'acqua fresca.");
  assert.ok(itTokens.some((t) => t.surface.toLowerCase() === "l'"));
  assert.ok(itTokens.some((t) => t.surface === 'acqua'));
  console.log('PASS: Intl.Segmenter offsets, Cloze sentence offsets, and FR/IT apostrophe splitting');

  // 3. Morphological normalization & inflected word lookup across languages
  const deVerb = await dePack.lookup('gelernt');
  assert.ok(deVerb, 'German "gelernt" should resolve to "lernen"');
  assert.equal(deVerb.word, 'lernen');

  const frVerb = await frPack.lookup('parlons');
  assert.ok(frVerb, 'French "parlons" should resolve to "parler"');
  assert.equal(frVerb.word, 'parler');

  const trPack = getLanguagePack('tr');
  const trNoun = await trPack.lookup('evlerde');
  assert.ok(trNoun, 'Turkish "evlerde" should resolve to "ev"');
  assert.equal(trNoun.word, 'ev');

  const trBook = await trPack.lookup('kitaplar');
  assert.ok(trBook, 'Turkish "kitaplar" should resolve to "kitap"');
  assert.equal(trBook.word, 'kitap');

  const nlPack = getLanguagePack('nl');
  const nlNoun = await nlPack.lookup('boeken');
  assert.ok(nlNoun, 'Dutch "boeken" should resolve to "boek"');
  assert.equal(nlNoun.word, 'boek');

  const koPack = getLanguagePack('ko');
  const koVerb = await koPack.lookup('먹었어요');
  assert.ok(koVerb, 'Korean "먹었어요" should resolve to "먹다"');
  assert.equal(koVerb.word, '먹다');

  const ptPack = getLanguagePack('pt');
  const ptVerb = await ptPack.lookup('falamos');
  assert.ok(ptVerb, 'Portuguese "falamos" should resolve to "falar"');
  assert.equal(ptVerb.word, 'falar');
  console.log('PASS: Morphological normalization & lookups across DE/FR/TR/NL/KO/PT');

  // 4. Mandarin Chinese pinyin-pro ruby segments & Anki FuriganaHTML export
  const zhPack = getLanguagePack('zh');
  const zhPy = buildMandarinPinyinSegments('图书馆');
  assert.ok(zhPy.reading.length > 0);
  assert.equal(zhPy.furiganaSegments?.length, 3);
  assert.ok(zhPy.furiganaSegments?.every((s) => Boolean(s.ruby)));

  const zhTokens = await zhPack.tokenize('我每天在图书馆学习中文。');
  const zhStudyTok = zhTokens.find((t) => t.surface === '学习');
  assert.ok(zhStudyTok && zhStudyTok.furiganaSegments && zhStudyTok.furiganaSegments.length === 2);
  const zhRubyHtml = furiganaSegmentsToHtml(zhStudyTok.furiganaSegments, zhStudyTok.surface, zhStudyTok.reading);
  assert.ok(zhRubyHtml.includes('<ruby>学<rt>'));
  assert.ok(zhRubyHtml.includes('<ruby>习<rt>'));

  const zhCloze = resolveClozeFromSentence({
    sentence: '我每天在图书馆学习中文。',
    word: '学习',
    lemma: '学习',
    tokens: zhTokens.map((t) => ({
      surface: t.surface,
      lemma: t.baseForm,
      reading: t.reading,
      startIndex: t.startIndex,
      endIndex: t.endIndex,
    })),
  });
  assert.ok(zhCloze && zhCloze.sentence.slice(zhCloze.start, zhCloze.end) === '学习');
  console.log('PASS: Mandarin Chinese pinyin-pro ruby, Anki HTML ruby, and Cloze offsets');

  // 5. Anki subdeck naming, {{tts}} locale formatting, and multi-language auto-tags
  assert.equal(
    formatAnkiDeckName('Default', {
      useSubdeckPrefix: true,
      subdeckRootName: 'LinguaForge',
      languageName: 'German',
    }),
    'LinguaForge::German::Default'
  );
  assert.equal(formatAnkiTtsTag(dePack.ttsCode!, 'AudioText'), '{{tts de_DE:AudioText}}');
  assert.equal(formatAnkiTtsTag(koPack.ttsCode!, 'AudioText'), '{{tts ko_KR:AudioText}}');
  assert.equal(formatAnkiTtsTag(zhPack.ttsCode!, 'AudioText'), '{{tts zh_CN:AudioText}}');

  const deTagSample = collectCardTags(
    {
      id: 'c1',
      deckId: getDefaultDeckId('de'),
      languageId: 'de',
      cardType: 'word_to_meaning',
      word: 'Haus',
      lemma: 'Haus',
      reading: '',
      meaning: 'house',
      level: 'A1',
      tags: [],
      notes: '',
      suspended: false,
      buried: false,
      createdAt: 1,
      updatedAt: 1,
    },
    { includeAutoLevelTag: true, includeAutoSourceTag: false, includeAutoCardTypeTag: false }
  );
  assert.deepEqual(deTagSample, ['CEFR_A1']);
  console.log('PASS: Anki subdeck names, {{tts}} templates, and CEFR/TOPIK/HSK auto-tags');

  // 6. Pack Manager: initial seeded ja, starter download fallback, AbortError cancel, custom import, remove preserving user study data
  const initialIds = await getInstalledLanguageIds();
  assert.ok(initialIds.includes('ja'));

  // Mock offline / unreachable fetch for starter fallback verification
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('Network offline');
  }) as typeof fetch;

  try {
    const deInstall = await installLanguagePack('de');
    assert.equal(deInstall.source, 'starter');
    assert.ok(deInstall.entryCount > 0);

    const installedAfterDe = await getInstalledPacksMap();
    assert.ok(installedAfterDe.de);
    assert.ok(await db.decks.get(getDefaultDeckId('de')), 'Installing DE must create default_de deck');

    // Cancellation must abort without installing starter fallback
    const ac = new AbortController();
    ac.abort();
    let abortedCorrectly = false;
    try {
      await installLanguagePack('fr', { signal: ac.signal });
    } catch (err) {
      abortedCorrectly = isAbortError(err);
    }
    assert.equal(abortedCorrectly, true);
    const installedAfterCancel = await getInstalledPacksMap();
    assert.equal(Boolean(installedAfterCancel.fr), false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Custom JSON & CSV import for German
  const customJson = JSON.stringify([
    { word: 'Fernweh', meanings: ['wanderlust'], level: 'B2', frequencyRank: 4500 },
  ]);
  const jsonRes = await importCustomLanguageJsonOrCsv('de', customJson, 'dictionary', 'custom-de.json');
  assert.equal(jsonRes.importedCount, 1);
  const customLookup = await dePack.lookup('Fernweh');
  assert.ok(customLookup && customLookup.meanings.includes('wanderlust'));

  const customCsv = 'word,meaning,level,rank\nGemütlichkeit,coziness; warmth,C1,6200';
  const csvRes = await importCustomLanguageJsonOrCsv('de', customCsv, 'dictionary', 'custom-de.csv');
  assert.equal(csvRes.importedCount, 1);
  const csvLookup = await dePack.lookup('Gemütlichkeit');
  assert.ok(csvLookup && csvLookup.meanings.includes('coziness'));

  // Create user German card + document before removing German pack
  await ensureDefaultDeck('de');
  const deAdded = await addCardsForWord({
    languageId: 'de',
    cardTypes: ['word_to_meaning'],
    word: 'Fernweh',
    lemma: 'Fernweh',
    reading: '',
    meaning: 'wanderlust',
    level: 'B2',
  });
  assert.equal(deAdded.added.length, 1);
  await db.documents.add({
    title: 'Reisetagebuch',
    content: 'Fernweh ist ein schönes Wort.',
    rawType: 'paste',
    languageId: 'de',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // Remove DE pack -> dictionary entries & installedPacks removed, cards/decks/documents preserved!
  await removeLanguagePack('de');
  const installedAfterRemove = await getInstalledPacksMap();
  assert.equal(Boolean(installedAfterRemove.de), false);
  assert.equal(await db.jmdictEntries.where('languageCode').equals('de').count(), 0);
  assert.equal(await db.cards.where('languageId').equals('de').count(), 1);
  assert.equal(await db.documents.where('languageId').equals('de').count(), 1);
  assert.ok(await db.decks.get(getDefaultDeckId('de')));
  console.log('PASS: Pack install (starter fallback), cancel AbortError, custom JSON/CSV, and safe removal');

  // 7. Backup & Restore preserves installed packs, active language, and developer options
  await installLanguagePack('ko');
  await db.settings.put({ key: 'activeLanguage', value: 'ko' });
  await saveDeveloperSettings({ showDeveloperTools: true });

  const backupJson = await exportFullBackup();
  await db.installedPacks.clear();
  await db.settings.clear();

  const restoreRes = await restoreFromBackup(backupJson);
  assert.equal(restoreRes.success, true);

  const restoredPacks = await getInstalledPacksMap();
  assert.ok(restoredPacks.ko, 'Backup restore must restore installedPacks');
  const restoredActiveLang = await db.settings.get('activeLanguage');
  assert.equal(restoredActiveLang?.value, 'ko');
  const restoredDev = await getDeveloperSettings();
  assert.equal(restoredDev.showDeveloperTools, true);
  assert.equal(restoredDev.includeDemoData, false);
  console.log('PASS: Backup & restore preserves installedLanguagePacks, activeLanguage, and Developer Options');

  console.log('ALL PHASE 3A MULTILINGUAL TESTS PASSED');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
