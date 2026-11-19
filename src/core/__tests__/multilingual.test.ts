import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { db } from '../../db/db';
import { addCardsForWord, ensureDefaultDeck, getDefaultDeckId } from '../../db/cards';
import { mapFrequencyRankToLevel, packSupportsRuby } from '../languagePack';
import { getAllLanguagePacks, getLanguagePack } from '../../packs/registry';
import {
  buildMandarinPinyinSegments,
  explainMultilingualInflection,
} from '../../packs/multilingualPack';
import {
  deinflectJapanese,
  explainJapaneseInflection,
  getJapaneseComponentMeaning,
} from '../../packs/japanese/deinflector';
import { mergeRawTokens } from '../../packs/japanese/tokenizer.worker';
import { postMergeJapaneseTokens } from '../../packs/japanese/tokenizer';
import { extractSentenceWithOffsets, resolveClozeFromSentence } from '../cloze';
import {
  collectCardTags,
  formatAnkiDeckName,
  furiganaSegmentsToHtml,
} from '../ankiExportCore';
import { formatAnkiTtsTag } from '../speech';
import {
  DEFAULT_PACK_MANIFEST_URL,
  getInstalledLanguageIds,
  getInstalledPacksMap,
  getPackManifestUrl,
  importCustomLanguageJsonOrCsv,
  installLanguagePack,
  isAbortError,
  removeLanguagePack,
  resolveManifestPackUrl,
  setPackManifestUrl,
  toggleLanguageSubpack,
} from '../packManager';
import { getDeveloperSettings, saveDeveloperSettings } from '../studySettings';
import { exportFullBackup, restoreFromBackup } from '../backup';
import { gzipSync } from 'node:zlib';

async function runTests() {
  console.log('--- Running Phase 3A Multi-Language Support & Pack Manager Tests ---');

  await db.delete();
  await db.open();

  // 1. Registry: 10 languages with expected metadata, TTS codes, level systems, and ruby flags
  const allPacks = getAllLanguagePacks();
  const ids = allPacks.map((p) => p.id);
  assert.deepEqual(ids, ['ja', 'de', 'fr', 'it', 'pt', 'tr', 'nl', 'ko', 'zh', 'es']);

  const expectedMeta: Record<string, { native: string; tts: string; levelName: string; ruby: boolean }> = {
    ja: { native: '日本語', tts: 'ja-JP', levelName: 'JLPT', ruby: true },
    de: { native: 'Deutsch', tts: 'de-DE', levelName: 'CEFR', ruby: false },
    fr: { native: 'Français', tts: 'fr-FR', levelName: 'CEFR', ruby: false },
    it: { native: 'Italiano', tts: 'it-IT', levelName: 'CEFR', ruby: false },
    pt: { native: 'Português', tts: 'pt-BR', levelName: 'CEFR', ruby: false },
    tr: { native: 'Türkçe', tts: 'tr-TR', levelName: 'CEFR', ruby: false },
    nl: { native: 'Nederlands', tts: 'nl-NL', levelName: 'CEFR', ruby: false },
    ko: { native: '한국어', tts: 'ko-KR', levelName: 'TOPIK', ruby: false },
    zh: { native: '中文', tts: 'zh-CN', levelName: 'HSK', ruby: true },
    es: { native: 'Español', tts: 'es-ES', levelName: 'CEFR', ruby: false },
  };

  for (const [langId, exp] of Object.entries(expectedMeta)) {
    const p = getLanguagePack(langId);
    assert.equal(p.id, langId);
    assert.equal(p.nativeName, exp.native);
    assert.equal(p.ttsCode, exp.tts);
    assert.equal(p.levelSystem.name, exp.levelName);
    assert.equal(packSupportsRuby(p), exp.ruby);
    assert.ok(p.sampleTestPhrase && p.sampleTestPhrase.length > 0);
  }
  console.log('PASS: 10 languages registered with native names, TTS codes, level systems, and ruby flags');

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
  assert.ok(frTokens.some((t) => t.surface.toLowerCase() === "l'" && !t.isWord));
  assert.ok(frTokens.some((t) => t.surface === 'arbre' && t.isWord));
  assert.equal(await frPack.lookup("l'"), null, 'Elision prefix must never trigger homonym lookup');

  const itPack = getLanguagePack('it');
  const itTokens = await itPack.tokenize("Bevo l'acqua fresca.");
  assert.ok(itTokens.some((t) => t.surface.toLowerCase() === "l'" && !t.isWord));
  assert.ok(itTokens.some((t) => t.surface === 'acqua' && t.isWord));
  assert.equal(await itPack.lookup("l'"), null, 'Italian elision prefix must never trigger lookup');
  console.log('PASS: Intl.Segmenter offsets, Cloze sentence offsets, and FR/IT non-lookupable elision prefixes');

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
  const koSentenceText = '저는 집에서 한국어를 공부합니다.';
  const koTokens = await koPack.tokenize(koSentenceText);
  const koWordSurfaces = koTokens.filter((t) => t.isWord).map((t) => t.surface);
  assert.deepEqual(koWordSurfaces, ['저는', '집에서', '한국어를', '공부합니다']);
  for (const tok of koTokens) {
    assert.equal(koSentenceText.slice(tok.startIndex, tok.endIndex), tok.surface);
  }
  const koHouse = await koPack.lookup('집에서');
  assert.ok(koHouse && koHouse.word === '집');
  const koLang = await koPack.lookup('한국어를');
  assert.ok(koLang && koLang.word === '한국어');
  const koStudy = await koPack.lookup('공부합니다');
  assert.ok(koStudy && koStudy.word === '공부하다');
  const koGo = await koPack.lookup('갔어요');
  assert.ok(koGo && koGo.word === '가다');
  const koVerb = await koPack.lookup('먹었어요');
  assert.ok(koVerb, 'Korean "먹었어요" should resolve to "먹다"');
  assert.equal(koVerb.word, '먹다');

  const ptPack = getLanguagePack('pt');
  const ptVerb = await ptPack.lookup('falamos');
  assert.ok(ptVerb, 'Portuguese "falamos" should resolve to "falar"');
  assert.equal(ptVerb.word, 'falar');

  const esPack = getLanguagePack('es');
  const esText = 'Hoy leo un libro nuevo. Mañana hablamos español.';
  const esTokens = await esPack.tokenize(esText);
  for (const tok of esTokens) {
    assert.equal(esText.slice(tok.startIndex, tok.endIndex), tok.surface);
  }
  const esBookTok = esTokens.find((t) => t.surface === 'libro');
  assert.ok(esBookTok);
  const esSentence = extractSentenceWithOffsets(esText, esBookTok.startIndex, esBookTok.endIndex);
  assert.equal(esSentence?.sentence, 'Hoy leo un libro nuevo.');

  const esVerb = await esPack.lookup('hablamos');
  assert.ok(esVerb, 'Spanish "hablamos" should resolve to "hablar"');
  assert.equal(esVerb.word, 'hablar');
  const esNoun = await esPack.lookup('libros');
  assert.ok(esNoun, 'Spanish "libros" should resolve to "libro"');
  assert.equal(esNoun.word, 'libro');
  console.log('PASS: Morphological normalization & lookups across DE/FR/TR/NL/KO/PT/ES');

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
  assert.equal(formatAnkiTtsTag(esPack.ttsCode!, 'AudioText'), '{{tts es_ES:AudioText}}');

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

  // 7. Cloud Pack Loader v2.1: manifest URL, v2 { entries, forms }, packForms O(1) lookup, Mandarin longest-match, Japanese deinflection & merger
  assert.equal(
    DEFAULT_PACK_MANIFEST_URL,
    'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/manifest.json'
  );
  assert.equal(
    resolveManifestPackUrl({ file: 'zh.json.gz', version: '2.1.0' }, DEFAULT_PACK_MANIFEST_URL),
    'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/zh.json.gz'
  );
  assert.equal(mapFrequencyRankToLevel('de', 800), 'A1');
  assert.equal(mapFrequencyRankToLevel('de', 1500), 'A2');
  assert.equal(mapFrequencyRankToLevel('zh', 900), 'HSK 1');
  assert.equal(mapFrequencyRankToLevel('ko', 4500), 'TOPIK 3');

  const compactZhV2PackJson = JSON.stringify({
    entries: [
      { w: '图书馆', r: 'tú shū guǎn', t: '圖書館', p: 'noun', m: ['library'], f: 850 },
      { w: '火车站', r: 'huǒ chē zhàn', t: '火車站', p: 'noun', m: ['train station'], f: 1800 },
    ],
    forms: {},
  });
  const gzZhBuffer = gzipSync(Buffer.from(compactZhV2PackJson, 'utf-8'));

  const ptV2PackJson = JSON.stringify({
    entries: [
      { w: 'falar', p: 'verb', m: ['to speak', 'to talk'], f: 185 },
      { w: 'comer', p: 'verb', m: ['to eat'], f: 430 },
    ],
    forms: {
      falávamos: 'falar',
      falavam: ['falar'],
    },
  });
  const gzPtBuffer = gzipSync(Buffer.from(ptV2PackJson, 'utf-8'));

  const esV2PackJson = JSON.stringify({
    entries: [
      { w: 'como', p: 'conjunction / adverb', m: ['like', 'as', 'how'], f: 35 },
      { w: 'comer', p: 'verb', m: ['to eat'], f: 290 },
    ],
    forms: {
      como: 'comer',
      comiendo: 'comer',
    },
  });
  const gzEsBuffer = gzipSync(Buffer.from(esV2PackJson, 'utf-8'));

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === DEFAULT_PACK_MANIFEST_URL) {
      return new Response(
        JSON.stringify({
          manifestVersion: '2.1',
          packs: {
            zh: { file: 'zh.json.gz', version: '2.1.0', entryCount: 2, sizeBytes: gzZhBuffer.byteLength },
            pt: { file: 'pt.json.gz', version: '2.1.0', entryCount: 2, sizeBytes: gzPtBuffer.byteLength },
            es: { file: 'es.json.gz', version: '2.1.0', entryCount: 2, sizeBytes: gzEsBuffer.byteLength },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url === 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/zh.json.gz') {
      return new Response(new Uint8Array(gzZhBuffer), {
        status: 200,
        headers: { 'content-length': String(gzZhBuffer.byteLength) },
      });
    }
    if (url === 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/pt.json.gz') {
      return new Response(new Uint8Array(gzPtBuffer), {
        status: 200,
        headers: { 'content-length': String(gzPtBuffer.byteLength) },
      });
    }
    if (url === 'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/es.json.gz') {
      return new Response(new Uint8Array(gzEsBuffer), {
        status: 200,
        headers: { 'content-length': String(gzEsBuffer.byteLength) },
      });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;

  try {
    const zhCloudInstall = await installLanguagePack('zh', { mode: 'cloud-strict' });
    assert.equal(zhCloudInstall.source, 'cloud');
    assert.equal(zhCloudInstall.record.version, '2.1.0');
    assert.ok(zhCloudInstall.entryCount >= 2);

    const zhSimplifiedLookup = await zhPack.lookup('图书馆');
    assert.ok(zhSimplifiedLookup);
    assert.equal(zhSimplifiedLookup.meanings[0], 'library');
    assert.equal(zhSimplifiedLookup.level, 'HSK 1');

    const zhTraditionalLookup = await zhPack.lookup('圖書館');
    assert.ok(zhTraditionalLookup, 'Traditional form t should resolve to the dictionary entry');
    assert.equal(zhTraditionalLookup.word, '图书馆');

    const zhStationLookup = await zhPack.lookup('火车站');
    assert.ok(zhStationLookup);
    assert.equal(zhStationLookup.level, 'HSK 2');

    // Mandarin forward longest-dictionary-match keeps multi-char CC-CEDICT compounds grouped
    const zhCompoundText = '我在图书馆和火车站学习中文。';
    const zhCompoundTokens = await zhPack.tokenize(zhCompoundText);
    const zhLibTok = zhCompoundTokens.find((t) => t.surface === '图书馆');
    const zhStaTok = zhCompoundTokens.find((t) => t.surface === '火车站');
    assert.ok(zhLibTok, 'Mandarin tokenizer must keep "图书馆" grouped as a single token');
    assert.ok(zhStaTok, 'Mandarin tokenizer must keep "火车站" grouped as a single token');
    assert.equal(zhLibTok.furiganaSegments?.length, 3);
    assert.equal(zhStaTok.furiganaSegments?.length, 3);
    for (const tok of zhCompoundTokens) {
      assert.equal(zhCompoundText.slice(tok.startIndex, tok.endIndex), tok.surface);
    }

    // Portuguese v2 packForms lookup ("falávamos" -> "falar")
    await installLanguagePack('pt', { mode: 'cloud-strict' });
    const ptFormRow = await db.packForms.get(['pt', 'falávamos']);
    assert.ok(ptFormRow && ptFormRow.lemmas.includes('falar'));
    const ptInflectedLookup = await ptPack.lookup('falávamos');
    assert.ok(ptInflectedLookup && ptInflectedLookup.word === 'falar');
    assert.equal(ptInflectedLookup.inflectedSurface, 'falávamos');

    // Spanish v2 standalone homonym + forms ("como" -> direct "como" entry + formOf: ["comer"], and "comiendo" -> "comer")
    await installLanguagePack('es', { mode: 'cloud-strict' });
    const esComiendo = await esPack.lookup('comiendo');
    assert.ok(esComiendo && esComiendo.word === 'comer');
    const esHomonym = await esPack.lookup('como');
    assert.ok(esHomonym && esHomonym.word === 'como');
    assert.ok(
      esHomonym.formOf && esHomonym.formOf.some((f) => f.lemma === 'comer'),
      'Standalone homonym "como" must also include formOf link to "comer"'
    );

    // cloud-strict must throw cleanly on missing pack/404 so UI displays Error + Retry
    let strictErrored = false;
    try {
      await installLanguagePack('it', { mode: 'cloud-strict' });
    } catch {
      strictErrored = true;
    }
    assert.equal(strictErrored, true);

    // Developer sub-pack toggle
    await toggleLanguageSubpack('zh', 'zh-freq-hsk', 'remove');
    const afterSubRemove = await getInstalledPacksMap();
    assert.equal(afterSubRemove.zh?.subpacks?.includes('zh-freq-hsk'), false);
    await toggleLanguageSubpack('zh', 'zh-freq-hsk', 'add');
    const afterSubAdd = await getInstalledPacksMap();
    assert.equal(afterSubAdd.zh?.subpacks?.includes('zh-freq-hsk'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('PASS: Cloud Pack Loader v2.1 (v2 {entries, forms}, packForms O(1), ZH longest-match, PT/ES forms & homonyms)');

  // 7b. Japanese Morphological Token Merger & Backward-Chaining Deinflector
  const jaPack = getLanguagePack('ja');
  const deinf1 = deinflectJapanese('食べています');
  assert.ok(deinf1.some((c) => c.lemma === '食べる'), 'Deinflector must resolve "食べています" -> "食べる"');
  const deinf2 = deinflectJapanese('食べられなかった');
  assert.ok(deinf2.some((c) => c.lemma === '食べる'), 'Deinflector must resolve "食べられなかった" -> "食べる"');
  const deinf3 = deinflectJapanese('書いています');
  assert.ok(deinf3.some((c) => c.lemma === '書く'), 'Deinflector must resolve "書いています" -> "書く"');
  const deinf4 = deinflectJapanese('美味しくなかった');
  assert.ok(deinf4.some((c) => c.lemma === '美味しい'), 'Deinflector must resolve "美味しくなかった" -> "美味しい"');

  const jaText = '私は毎日ご飯を食べています。昨日は食べられなかった。';
  const jaTokens = await jaPack.tokenize(jaText);
  const tabeteimasuTok = jaTokens.find((t) => t.surface === '食べています');
  const taberarenakattaTok = jaTokens.find((t) => t.surface === '食べられなかった');
  assert.ok(tabeteimasuTok, 'Japanese tokenizer must merge "食べています" into ONE single token');
  assert.equal(tabeteimasuTok.baseForm, '食べる');
  assert.equal(jaText.slice(tabeteimasuTok.startIndex, tabeteimasuTok.endIndex), '食べています');
  assert.ok(taberarenakattaTok, 'Japanese tokenizer must merge "食べられなかった" into ONE single token');
  assert.equal(taberarenakattaTok.baseForm, '食べる');
  assert.equal(jaText.slice(taberarenakattaTok.startIndex, taberarenakattaTok.endIndex), '食べられなかった');

  // Verify Kuromoji raw token merger merges 動詞 + 助詞(接続助詞) + 動詞(非自立) + 助動詞
  const kuromojiMerged = mergeRawTokens(
    [
      { surface_form: '食べ', pos: '動詞', pos_detail_1: '自立', pos_detail_2: '*', pos_detail_3: '*', conjugated_type: '一段', conjugated_form: '連用形', basic_form: '食べる', reading: 'タベ' },
      { surface_form: 'て', pos: '助詞', pos_detail_1: '接続助詞', pos_detail_2: '*', pos_detail_3: '*', conjugated_type: '*', conjugated_form: '*', basic_form: 'て', reading: 'テ' },
      { surface_form: 'い', pos: '動詞', pos_detail_1: '非自立', pos_detail_2: '*', pos_detail_3: '*', conjugated_type: '一段', conjugated_form: '連用形', basic_form: 'いる', reading: 'イ' },
      { surface_form: 'ます', pos: '助動詞', pos_detail_1: '*', pos_detail_2: '*', pos_detail_3: '*', conjugated_type: '特殊・マス', conjugated_form: '基本形', basic_form: 'ます', reading: 'マス' },
    ],
    '食べています'
  );
  assert.equal(kuromojiMerged.length, 1);
  assert.equal(kuromojiMerged[0].surface, '食べています');
  assert.equal(kuromojiMerged[0].baseForm, '食べる');

  const jaLookupNoLemma = await jaPack.lookup('食べています');
  assert.ok(jaLookupNoLemma && jaLookupNoLemma.word === '食べる');
  assert.equal(jaLookupNoLemma.conjugatedForm, '食べています');
  const jaLookupNegPot = await jaPack.lookup('食べられなかった');
  assert.ok(jaLookupNegPot && jaLookupNegPot.word === '食べる');
  console.log('PASS: Japanese morphological token merger, Kuromoji raw merger, and backward-chaining deinflector');

  // 7c. Phase 3C: Inline Grammar Explanations across all 10 languages
  // Japanese single & chained deinflection meanings + component glosses
  const jaNagara = explainJapaneseInflection('食べながら', '食べる');
  assert.ok(jaNagara);
  assert.equal(jaNagara.grammarSuffix, '-ながら');
  assert.match(jaNagara.grammarMeaning || '', /while doing/i);

  const jaTeiru = explainJapaneseInflection('食べています', '食べる');
  assert.ok(jaTeiru);
  assert.match(jaTeiru.grammarMeaning || '', /ongoing state/i);
  assert.match(jaTeiru.grammarMeaning || '', /polite/i);

  const jaChained = explainJapaneseInflection('食べさせられた', '食べる');
  assert.ok(jaChained);
  assert.equal(jaChained.grammarSuffix, '-させられた');
  assert.equal(jaChained.grammarMeaning, 'causative + passive + past');
  assert.deepEqual(
    jaChained.grammarSteps.map((s) => s.meaning),
    [
      'causative (make/let do)',
      'passive / potential (can / be done)',
      'past tense',
    ]
  );

  assert.equal(jaLookupNoLemma.grammarSuffix, '-ています');
  assert.ok(jaLookupNoLemma.grammarMeaning && /ongoing state/i.test(jaLookupNoLemma.grammarMeaning));

  assert.ok(kuromojiMerged[0].grammarMeaning && /ongoing state/i.test(kuromojiMerged[0].grammarMeaning));
  assert.ok(kuromojiMerged[0].components && kuromojiMerged[0].components.length === 4);
  for (const comp of kuromojiMerged[0].components.slice(1)) {
    assert.ok(comp.meaning && comp.meaning.length > 0, `Component ${comp.surface} must carry a concise English gloss`);
  }
  assert.match(getJapaneseComponentMeaning('ながら', 'ながら', '助詞') || '', /while doing/i);
  assert.match(getJapaneseComponentMeaning('ます', 'ます', '助動詞') || '', /polite/i);

  const jaTokSingle = await jaPack.tokenize('歩きながら話した');
  const arukunagara = jaTokSingle.find((t) => t.surface === '歩きながら');
  assert.ok(arukunagara && arukunagara.baseForm === '歩く');
  assert.equal(arukunagara.grammarSuffix, '-きながら');
  assert.match(arukunagara.grammarMeaning || '', /while doing/i);

  // Korean particles & chained verb endings
  const koLocative = explainMultilingualInflection('ko', '학교에서', {
    word: '학교',
    meanings: ['school'],
    partsOfSpeech: ['noun'],
  });
  assert.ok(koLocative);
  assert.equal(koLocative.grammarSuffix, '-에서');
  assert.match(koLocative.grammarMeaning || '', /at \/ in/i);

  const koChainedVerb = explainMultilingualInflection('ko', '먹었습니다', {
    word: '먹다',
    meanings: ['to eat'],
    partsOfSpeech: ['verb'],
  });
  assert.ok(koChainedVerb);
  assert.match(koChainedVerb.grammarMeaning || '', /past/i);
  assert.match(koChainedVerb.grammarMeaning || '', /polite/i);

  const koPack3c = getLanguagePack('ko');
  await importCustomLanguageJsonOrCsv(
    'ko',
    JSON.stringify([
      { word: '학교', reading: 'hakgyo', meanings: ['school'], level: 'TOPIK 1', frequencyRank: 400 },
      { word: '먹다', reading: 'meokda', meanings: ['to eat'], level: 'TOPIK 1', frequencyRank: 200 },
    ]),
    'dictionary',
    'ko-phase3c.json'
  );
  const koLookupParticle = await koPack3c.lookup('학교에서');
  assert.ok(koLookupParticle && koLookupParticle.word === '학교');
  assert.equal(koLookupParticle.grammarSuffix, '-에서');
  assert.match(koLookupParticle.grammarMeaning || '', /at \/ in/i);

  const koLookupVerb = await koPack3c.lookup('먹었습니다');
  assert.ok(koLookupVerb && koLookupVerb.word === '먹다');
  assert.match(koLookupVerb.grammarMeaning || '', /past/i);

  // Turkish vowel-harmony suffix layering in natural left-to-right order
  const trNounChain = explainMultilingualInflection('tr', 'evlerimizden', {
    word: 'ev',
    meanings: ['house', 'home'],
    partsOfSpeech: ['noun'],
  });
  assert.ok(trNounChain);
  assert.equal(trNounChain.grammarSuffix, '-lerimizden');
  assert.equal(trNounChain.grammarMeaning, 'plural + our + from');
  assert.deepEqual(
    trNounChain.grammarSteps?.map((s) => s.suffix),
    ['lerimiz', 'den']
  );

  const trPack3c = getLanguagePack('tr');
  await importCustomLanguageJsonOrCsv(
    'tr',
    JSON.stringify([
      { word: 'ev', meanings: ['house', 'home'], level: 'A1', frequencyRank: 150 },
      { word: 'gelmek', meanings: ['to come'], level: 'A1', frequencyRank: 180 },
    ]),
    'dictionary',
    'tr-phase3c.json'
  );
  const trLookupChain = await trPack3c.lookup('evlerimizden');
  assert.ok(trLookupChain && trLookupChain.word === 'ev');
  assert.equal(trLookupChain.grammarMeaning, 'plural + our + from');

  const trVerbProg = await trPack3c.lookup('geliyorum');
  assert.ok(trVerbProg && trVerbProg.word === 'gelmek');
  assert.match(trVerbProg.grammarMeaning || '', /present continuous/i);

  // European grammar explanations via packForms / stemmer / homonyms
  const ptPack3c = getLanguagePack('pt');
  const ptFalavamos = await ptPack3c.lookup('falávamos');
  assert.ok(ptFalavamos && ptFalavamos.word === 'falar');
  assert.match(ptFalavamos.grammarMeaning || '', /1st-person plural/i);
  assert.match(ptFalavamos.grammarMeaning || '', /imperfect/i);

  const esPack3c = getLanguagePack('es');
  const esComiendo3c = await esPack3c.lookup('comiendo');
  assert.ok(esComiendo3c && esComiendo3c.word === 'comer');
  assert.match(esComiendo3c.grammarMeaning || '', /gerund/i);

  const esComo3c = await esPack3c.lookup('como');
  assert.ok(esComo3c?.formOf && esComo3c.formOf[0].grammarMeaning);
  assert.match(esComo3c.formOf[0].grammarMeaning || '', /1st-person singular/i);

  const frExp = explainMultilingualInflection('fr', 'faisant', {
    word: 'faire',
    meanings: ['to do'],
    partsOfSpeech: ['verb'],
  });
  assert.ok(frExp && /present participle/i.test(frExp.grammarMeaning || ''));
  const itExp = explainMultilingualInflection('it', 'parlato', {
    word: 'parlare',
    meanings: ['to speak'],
    partsOfSpeech: ['verb'],
  });
  assert.ok(itExp && /past participle/i.test(itExp.grammarMeaning || ''));
  const deExp = explainMultilingualInflection('de', 'gelernt', {
    word: 'lernen',
    meanings: ['to learn'],
    partsOfSpeech: ['verb'],
  });
  assert.ok(deExp && /past participle/i.test(deExp.grammarMeaning || ''));
  const nlExp = explainMultilingualInflection('nl', 'werkte', {
    word: 'werken',
    meanings: ['to work'],
    partsOfSpeech: ['verb'],
  });
  assert.ok(nlExp && /past tense/i.test(nlExp.grammarMeaning || ''));

  console.log('PASS: Phase 3C inline grammar explanations (JA, KO, TR, PT, ES, FR, IT, DE, NL)');

  // 7d. Phase 3D: Japanese Rules A/B/C, Particle Protection & Cross-Language Modifiers
  await db.jmdictEntries.bulkPut([
    {
      id: 'test-ja-dentouteki',
      primaryWord: '伝統的',
      primaryReading: 'でんとうてき',
      kanji: [{ text: '伝統的' }],
      kana: [{ text: 'でんとうてき' }],
      senses: [{ glosses: ['traditional', 'conventional'], partsOfSpeech: ['adj-na'] }],
      priorityTags: ['ichi1'],
      priorityScore: 100,
      frequencyBand: 'Common',
      jlptLevel: 'N3',
      forms: ['伝統的', 'でんとうてき'],
      importIds: ['test-ja-3d'],
      kinds: ['dictionary'],
      languageCode: 'ja',
    },
    {
      id: 'test-ja-shizuka',
      primaryWord: '静か',
      primaryReading: 'しずか',
      kanji: [{ text: '静か' }],
      kana: [{ text: 'しずか' }],
      senses: [{ glosses: ['quiet', 'silent'], partsOfSpeech: ['adj-na'] }],
      priorityTags: ['ichi1'],
      priorityScore: 120,
      frequencyBand: 'Common',
      jlptLevel: 'N5',
      forms: ['静か', 'しずか'],
      importIds: ['test-ja-3d'],
      kinds: ['dictionary'],
      languageCode: 'ja',
    },
    {
      id: 'test-ja-seikatsu',
      primaryWord: '生活',
      primaryReading: 'せいかつ',
      kanji: [{ text: '生活' }],
      kana: [{ text: 'せいかつ' }],
      senses: [{ glosses: ['living', 'life', 'daily life'], partsOfSpeech: ['n', 'vs'] }],
      priorityTags: ['ichi1'],
      priorityScore: 130,
      frequencyBand: 'Common',
      jlptLevel: 'N4',
      forms: ['生活', 'せいかつ'],
      importIds: ['test-ja-3d'],
      kinds: ['dictionary'],
      languageCode: 'ja',
    },
    {
      id: 'test-ja-benkyousuru',
      primaryWord: '勉強する',
      primaryReading: 'べんきょうする',
      kanji: [{ text: '勉強する' }],
      kana: [{ text: 'べんきょうする' }],
      senses: [{ glosses: ['to study'], partsOfSpeech: ['vs-i'] }],
      priorityTags: ['ichi1'],
      priorityScore: 140,
      frequencyBand: 'Common',
      jlptLevel: 'N5',
      forms: ['勉強する', 'べんきょうする'],
      importIds: ['test-ja-3d'],
      kinds: ['dictionary'],
      languageCode: 'ja',
    },
    {
      id: 'test-ja-undou',
      primaryWord: '運動',
      primaryReading: 'うんどう',
      kanji: [{ text: '運動' }],
      kana: [{ text: 'うんどう' }],
      senses: [{ glosses: ['exercise', 'physical training'], partsOfSpeech: ['n', 'vs'] }],
      priorityTags: ['ichi1'],
      priorityScore: 110,
      frequencyBand: 'Common',
      jlptLevel: 'N4',
      forms: ['運動', 'うんどう'],
      importIds: ['test-ja-3d'],
      kinds: ['dictionary'],
      languageCode: 'ja',
    },
    {
      id: 'test-ja-na-vegetables-trap',
      primaryWord: '菜',
      primaryReading: 'な',
      kanji: [{ text: '菜' }],
      kana: [{ text: 'な' }],
      senses: [{ glosses: ['greens', 'vegetables'], partsOfSpeech: ['n'] }],
      priorityTags: ['news1'],
      priorityScore: 200,
      frequencyBand: 'Common',
      jlptLevel: 'N1',
      forms: ['菜', 'な'],
      importIds: ['test-ja-3d'],
      kinds: ['dictionary'],
      languageCode: 'ja',
    },
  ]);

  // Rule A + Rule B via Intl.Segmenter + postMergeJapaneseTokens
  const jaDentouText = '伝統的な料理と大切なこと。';
  const jaDentouToks = await jaPack.tokenize(jaDentouText);
  const dentouTok = jaDentouToks.find((t) => t.surface === '伝統的な');
  const taisetsuTok = jaDentouToks.find((t) => t.surface === '大切な');
  assert.ok(dentouTok, 'Rule A+B must merge "伝統" + "的" + "な" into "伝統的な"');
  assert.equal(dentouTok.baseForm, '伝統的');
  assert.equal(dentouTok.grammarSuffix, '-な');
  assert.match(dentouTok.grammarMeaning || '', /na-adjective modifier/i);
  assert.ok(taisetsuTok, 'Rule B must merge "大切" + "な" into "大切な"');
  assert.equal(taisetsuTok.baseForm, '大切');
  assert.equal(taisetsuTok.grammarSuffix, '-な');

  // Rule B copula & adverbial chains
  const jaShizukaText = '静かだった。静かではない。静かじゃない。静かに歩く。';
  const jaShizukaToks = await jaPack.tokenize(jaShizukaText);
  for (const expectedSurface of ['静かだった', '静かではない', '静かじゃない', '静かに']) {
    const found = jaShizukaToks.find((t) => t.surface === expectedSurface);
    assert.ok(found, `Rule B must merge "${expectedSurface}" into ONE token`);
    assert.equal(found.baseForm, '静か');
  }
  assert.match(
    jaShizukaToks.find((t) => t.surface === '静かに')?.grammarMeaning || '',
    /adverbial/i
  );
  assert.match(
    jaShizukaToks.find((t) => t.surface === '静かだった')?.grammarMeaning || '',
    /past \/ negative copula/i
  );

  // Rule A + B also works identically on Kuromoji raw token streams
  const kuromojiRuleABRaw = mergeRawTokens(
    [
      { surface_form: '伝統', pos: '名詞', pos_detail_1: '一般', pos_detail_2: '*', pos_detail_3: '*', conjugated_type: '*', conjugated_form: '*', basic_form: '伝統', reading: 'デントウ' },
      { surface_form: '的', pos: '名詞', pos_detail_1: '接尾', pos_detail_2: '形容動詞語幹', pos_detail_3: '*', conjugated_type: '*', conjugated_form: '*', basic_form: '的', reading: 'テキ' },
      { surface_form: 'な', pos: '助動詞', pos_detail_1: '*', pos_detail_2: '*', pos_detail_3: '*', conjugated_type: '特殊・ダ', conjugated_form: '体言接続', basic_form: 'だ', reading: 'ナ' },
    ],
    '伝統的な'
  );
  const kuromojiRuleABMerged = await postMergeJapaneseTokens(kuromojiRuleABRaw);
  assert.equal(kuromojiRuleABMerged.length, 1);
  assert.equal(kuromojiRuleABMerged[0].surface, '伝統的な');
  assert.equal(kuromojiRuleABMerged[0].baseForm, '伝統的');

  // Rule C: Suru-verbs (生活する, 勉強しています, 運動できる)
  const jaSuruText = '生活する。勉強しています。運動できる。';
  const jaSuruToks = await jaPack.tokenize(jaSuruText);
  const seikatsuTok = jaSuruToks.find((t) => t.surface === '生活する');
  const benkyouTok = jaSuruToks.find((t) => t.surface === '勉強しています');
  const undouTok = jaSuruToks.find((t) => t.surface === '運動できる');
  assert.ok(seikatsuTok, 'Rule C must merge "生活する"');
  assert.equal(seikatsuTok.baseForm, '生活'); // 生活する not in JMdict, 生活 (vs) is
  assert.match(seikatsuTok.grammarMeaning || '', /\+ する/);
  assert.equal(seikatsuTok.components?.length, 2);
  assert.match(seikatsuTok.components?.[1].meaning || '', /to do — turns noun into a verb/i);

  assert.ok(benkyouTok, 'Rule C must merge "勉強しています"');
  assert.equal(benkyouTok.baseForm, '勉強する'); // 勉強する IS in JMdict
  assert.match(benkyouTok.grammarMeaning || '', /\+ する/);
  assert.equal(benkyouTok.components?.length, 2);

  assert.ok(undouTok, 'Rule C must merge "運動できる"');
  assert.match(undouTok.grammarMeaning || '', /\+ する/);
  assert.equal(undouTok.components?.length, 2);

  // Protected Japanese standalone particles & copulas never map to kanji homonyms like 菜
  const jaProtectedNa = await jaPack.lookup('な');
  assert.ok(jaProtectedNa);
  assert.equal(jaProtectedNa.word, 'な');
  assert.ok(jaProtectedNa.partsOfSpeech.includes('Grammar Particle'));
  assert.ok(!jaProtectedNa.meanings.some((m) => /vegetables/i.test(m)), '"な" must NEVER map to 菜 (vegetables)');
  const jaProtectedDesu = await jaPack.lookup('です');
  assert.ok(jaProtectedDesu && jaProtectedDesu.partsOfSpeech.includes('Copula'));
  const jaProtectedNo = await jaPack.lookup('の');
  assert.ok(jaProtectedNo && jaProtectedNo.partsOfSpeech.includes('Grammar Particle'));

  // Korean -ㄴ/-은/-는 attributive modifier & Noun + 하다/되다 light verbs
  await importCustomLanguageJsonOrCsv(
    'ko',
    JSON.stringify([
      { word: '중요하다', reading: 'jungyohada', meanings: ['to be important'], partsOfSpeech: ['adjective'], level: 'TOPIK 2', frequencyRank: 300 },
      { word: '공부하다', reading: 'gongbuhada', meanings: ['to study'], partsOfSpeech: ['verb'], level: 'TOPIK 1', frequencyRank: 250 },
    ]),
    'dictionary',
    'ko-phase3d.json'
  );
  const koMod = await koPack3c.lookup('중요한');
  assert.ok(koMod && koMod.word === '중요하다');
  assert.equal(koMod.grammarMeaning, 'attributive modifier form (modifies following noun)');
  const koLvExact = await koPack3c.lookup('공부하다');
  assert.ok(koLvExact && koLvExact.word === '공부하다');
  assert.equal(koLvExact.grammarMeaning, '+ 하다 (to do — verb form)');
  assert.equal(koLvExact.grammarComponents?.length, 2);
  const koLvPast = await koPack3c.lookup('공부했어요');
  assert.ok(koLvPast && koLvPast.word === '공부하다');
  assert.match(koLvPast.grammarMeaning || '', /\+ 하다 \(to do — verb form\)/);
  assert.equal(koLvPast.grammarComponents?.length, 2);

  // Turkish -li / -siz derivational adjective suffixes
  await importCustomLanguageJsonOrCsv(
    'tr',
    JSON.stringify([
      { word: 'önem', meanings: ['importance'], partsOfSpeech: ['noun'], level: 'B1', frequencyRank: 450 },
      { word: 'şeker', meanings: ['sugar'], partsOfSpeech: ['noun'], level: 'A1', frequencyRank: 500 },
    ]),
    'dictionary',
    'tr-phase3d.json'
  );
  const trOnemli = await trPack3c.lookup('önemli');
  assert.ok(trOnemli && trOnemli.word === 'önem');
  assert.equal(trOnemli.grammarSuffix, '-li');
  assert.equal(trOnemli.grammarMeaning, 'adjective suffix: with / having');
  const trSekersiz = await trPack3c.lookup('şekersiz');
  assert.ok(trSekersiz && trSekersiz.word === 'şeker');
  assert.equal(trSekersiz.grammarSuffix, '-siz');
  assert.equal(trSekersiz.grammarMeaning, 'adjective suffix: without');

  // Mandarin standalone 的
  const zhDe = await zhPack.lookup('的');
  assert.ok(zhDe);
  assert.ok(zhDe.partsOfSpeech.includes('Grammar Particle'));
  assert.match(zhDe.meanings[0] || '', /attributive modifier particle/i);

  // European inflected adjectives across ES, DE, FR, IT, NL
  const adjTests: Array<{ lang: string; surface: string; lemma: string }> = [
    { lang: 'es', surface: 'buena', lemma: 'bueno' },
    { lang: 'es', surface: 'buenos', lemma: 'bueno' },
    { lang: 'de', surface: 'großen', lemma: 'groß' },
    { lang: 'fr', surface: 'belle', lemma: 'beau' },
    { lang: 'it', surface: 'nuova', lemma: 'nuovo' },
    { lang: 'nl', surface: 'grote', lemma: 'groot' },
  ];
  for (const t of adjTests) {
    await importCustomLanguageJsonOrCsv(
      t.lang,
      JSON.stringify([{ word: t.lemma, meanings: ['test adjective'], partsOfSpeech: ['adjective'], level: 'A1', frequencyRank: 100 }]),
      'dictionary',
      `${t.lang}-adj-3d.json`
    );
    const res = await getLanguagePack(t.lang).lookup(t.surface);
    assert.ok(res && res.word === t.lemma, `${t.lang}: "${t.surface}" must resolve to "${t.lemma}"`);
    assert.equal(res.grammarMeaning, 'inflected adjective form (gender / number / case)');
  }

  console.log('PASS: Phase 3D Japanese Rules A/B/C, particle protection, and cross-language modifiers');

  // 8. Backup & Restore preserves installed packs, active language, manifest URL, and developer options
  await installLanguagePack('ko', { mode: 'starter' });
  await db.settings.put({ key: 'activeLanguageId', value: 'ko' });
  await setPackManifestUrl('https://example.com/custom/manifest.json');
  await saveDeveloperSettings({ showDeveloperTools: true });

  const backupJson = await exportFullBackup();
  await db.installedPacks.clear();
  await db.settings.clear();

  const restoreRes = await restoreFromBackup(backupJson);
  assert.equal(restoreRes.success, true);

  const restoredPacks = await getInstalledPacksMap();
  assert.ok(restoredPacks.ko, 'Backup restore must restore installedPacks');
  const restoredActiveLang = await db.settings.get('activeLanguageId');
  assert.equal(restoredActiveLang?.value, 'ko');
  const restoredManifestUrl = await getPackManifestUrl();
  assert.equal(restoredManifestUrl, 'https://example.com/custom/manifest.json');
  const restoredDev = await getDeveloperSettings();
  assert.equal(restoredDev.showDeveloperTools, true);
  assert.equal(restoredDev.includeDemoData, false);
  console.log('PASS: Backup & restore preserves installedLanguagePacks, activeLanguageId, manifestUrl, and Developer Options');

  console.log('ALL PHASE 3A + 3B + 3C + 3D MULTILINGUAL TESTS PASSED');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
