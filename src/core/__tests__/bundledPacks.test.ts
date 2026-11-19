import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { db } from '../../db/db';
import {
  detectCategoryColumnMapping,
  extractDictRowsFromTable,
  extractExampleRowsFromTable,
  extractFrequencyRowsFromTable,
  extractKanjiRowsFromTable,
  parseDelimitedPackTable,
  parseRfcDelimitedText,
  stripUtf8Bom,
} from '../packCsvParser';
import {
  DEFAULT_BUNDLED_PACKS,
  addCustomBundledPackByUrl,
  addCustomBundledPackFromFile,
  classifyDiscoveredPackPath,
  discoverPacksFromGlobMap,
  getAutoDiscoveredBasePacks,
  getBundledPacksCustomizations,
  getEffectiveBundledPacks,
  getIncludedPacksForLanguage,
  getInstalledBundledPacksMap,
  installAllAvailableLanguagePacks,
  installAllIncludedPacksForLanguage,
  isAbortError,
  previewCsvOrTsvForDeveloper,
  removeBundledPackFromRegistry,
  restoreDefaultBundledPacks,
} from '../bundledPacks';
import { exportFullBackup, restoreFromBackup } from '../backup';
import { getLanguagePack } from '../../packs/registry';

async function runTests() {
  console.log('--- Running Phase 4 Bundled Packs, Auto-Discovery & CSV/TSV Tests ---');

  await db.delete();
  await db.open();

  // -------------------------------------------------------------------------
  // 1. RFC-4180 CSV & TSV Parser Edge Cases
  // -------------------------------------------------------------------------
  const bomCsv =
    '\uFEFFWORD,Reading,Meaning,POS,Level\r\n' +
    '"図書館","としょかん","library; ""reading room""\npublic building","noun","N5"\r\n' +
    '勉強,べんきょう,"study, diligence",noun-suru,N5\r\n';
  const stripped = stripUtf8Bom(bomCsv);
  assert.equal(stripped.startsWith('WORD'), true);

  const rfcRows = parseRfcDelimitedText(stripped, ',');
  assert.equal(rfcRows.length, 3);
  assert.equal(rfcRows[1][0], '図書館');
  assert.equal(rfcRows[1][2], 'library; "reading room"\npublic building');
  assert.equal(rfcRows[2][2], 'study, diligence');

  const dictTable = parseDelimitedPackTable(bomCsv, 'ja-vocab.csv', 'common-dict');
  assert.equal(dictTable.delimiter, ',');
  assert.equal(dictTable.hasHeaderRow, true);
  const dictDetection = detectCategoryColumnMapping('common-dict', dictTable);
  assert.equal(dictDetection.autoDetected, true);
  const dictRows = extractDictRowsFromTable(dictTable, dictDetection.mapping);
  assert.equal(dictRows.length, 2);
  assert.equal(dictRows[0].word, '図書館');
  assert.equal(dictRows[0].readings[0], 'としょかん');
  assert.equal(dictRows[0].level, 'N5');

  // TSV parsing & unknown header fallback (triggers quick column-mapping preview in Dev UI)
  const unknownTsv = '水\tmizu\twater\n火\thi\tfire\n';
  const unknownTable = parseDelimitedPackTable(unknownTsv, 'custom.tsv', 'core-dict');
  assert.equal(unknownTable.delimiter, '\t');
  assert.equal(unknownTable.hasHeaderRow, false);
  const unknownDetection = detectCategoryColumnMapping('core-dict', unknownTable);
  assert.equal(unknownDetection.autoDetected, false);
  assert.equal(unknownDetection.missingRequired.includes('word'), true);

  // Manual column mapping extraction succeeds cleanly
  const manualDictRows = extractDictRowsFromTable(unknownTable, {
    word: 0,
    reading: 1,
    meaning: 2,
  });
  assert.equal(manualDictRows.length, 2);
  assert.equal(manualDictRows[0].word, '水');
  assert.equal(manualDictRows[0].meanings[0], 'water');

  // Examples CSV extraction
  const exCsv = 'sentence,translation,word,reading\r\n毎日勉強します。,I study every day.,勉強,まいにちべんきょうします\r\n';
  const exTable = parseDelimitedPackTable(exCsv, 'ja-examples.csv', 'examples');
  const exRows = extractExampleRowsFromTable(exTable);
  assert.equal(exRows.length, 1);
  assert.equal(exRows[0].word, '勉強');
  assert.equal(exRows[0].translation, 'I study every day.');

  // Kanji levels CSV extraction (normalizes both "N5" and "4" -> "N4")
  const kanjiCsv = 'character,jlpt,meaning,onyomi,kunyomi,strokes\n学,5,"study; learning",ガク,まな.ぶ,8\n強,N4,"strong",キョウ,つよ.い,11\n';
  const kanjiTable = parseDelimitedPackTable(kanjiCsv, 'ja-kanji.csv', 'kanji-levels');
  const kanjiRows = extractKanjiRowsFromTable(kanjiTable, 'ja-kanji.csv');
  assert.equal(kanjiRows.length, 2);
  assert.equal(kanjiRows[0].jlptLevel, 'N5');
  assert.equal(kanjiRows[1].jlptLevel, 'N4');
  assert.equal(kanjiRows[0].strokeCount, 8);

  // Frequency CSV: 2-column & single-column sequential rank fallback
  const freqSingle = 'word\nの\nに\n勉強\n';
  const freqSingleTable = parseDelimitedPackTable(freqSingle, 'ja-freq.csv', 'frequency');
  const freqSingleRows = extractFrequencyRowsFromTable(freqSingleTable);
  assert.deepEqual(freqSingleRows, [
    { word: 'の', rank: 1 },
    { word: 'に', rank: 2 },
    { word: '勉強', rank: 3 },
  ]);

  const freqTwoCol = 'term\trank\n勉強\t42\n図書館\t310\n';
  const freqTwoTable = parseDelimitedPackTable(freqTwoCol, 'ja-freq.tsv', 'frequency');
  const freqTwoRows = extractFrequencyRowsFromTable(freqTwoTable);
  assert.deepEqual(freqTwoRows, [
    { word: '勉強', rank: 42 },
    { word: '図書館', rank: 310 },
  ]);

  // -------------------------------------------------------------------------
  // 2. Auto-Discovery & Classification (`public/packs/` Glob Simulation)
  // -------------------------------------------------------------------------
  const c1 = classifyDiscoveredPackPath('/public/packs/ko-common.csv', '/packs/ko-common.csv');
  assert.ok(c1);
  assert.equal(c1.languageId, 'ko');
  assert.equal(c1.category, 'common-dict');
  assert.equal(c1.fileFormat, 'csv');

  const c2 = classifyDiscoveredPackPath('/public/packs/de/tatoeba-examples.tsv');
  assert.ok(c2);
  assert.equal(c2.languageId, 'de');
  assert.equal(c2.category, 'examples');
  assert.equal(c2.fileFormat, 'tsv');

  const cIgnored = classifyDiscoveredPackPath('/public/packs/README.txt');
  assert.equal(cIgnored, null);

  const globDiscovered = discoverPacksFromGlobMap({
    '/public/packs/ja-kanji-levels.csv': '/packs/ja-kanji-levels.csv',
    '/public/packs/ko-common-vocab.csv': '/packs/ko-common-vocab.csv',
    '/public/packs/fr-freq.tsv': '/packs/fr-freq.tsv',
    '/public/packs/ignored.md': '/packs/ignored.md',
  });
  assert.equal(globDiscovered.length, 3);

  const mergedBase = getAutoDiscoveredBasePacks(DEFAULT_BUNDLED_PACKS, {
    '/public/packs/ja-kanji-levels.csv': '/packs/ja-kanji-levels.csv',
    '/public/packs/ko-common-vocab.csv': '/packs/ko-common-vocab.csv',
  });
  // `ja-kanji-levels.csv` should merge onto existing default rather than duplicate
  const jaKanjiCount = mergedBase.filter(
    (p) => p.languageId === 'ja' && p.category === 'kanji-levels'
  ).length;
  assert.equal(jaKanjiCount, 1);
  assert.equal(
    mergedBase.some((p) => p.languageId === 'ko' && p.category === 'common-dict'),
    true
  );

  // -------------------------------------------------------------------------
  // 3. Verify Real Public Starter CSV Files Exist & Parse Cleanly
  // -------------------------------------------------------------------------
  const publicPacksDir = path.resolve(process.cwd(), 'public/packs');
  for (const file of [
    'ja-kanji-levels.csv',
    'ja-examples.csv',
    'ja-frequency.csv',
    'es-examples.csv',
    'de-examples.csv',
    'fr-examples.csv',
  ]) {
    const fullPath = path.join(publicPacksDir, file);
    assert.equal(fs.existsSync(fullPath), true, `Expected ${file} in public/packs/`);
  }

  // -------------------------------------------------------------------------
  // 4. Sequential Install All Included Packs for Japanese & Lookup Integration
  // -------------------------------------------------------------------------
  const originalFetch = globalThis.fetch;
  try {
    // Mock fetch to serve real public/packs/*.csv files from disk + simulate offline/v2 responses
    const jaCloudV2Payload = gzipSync(
      Buffer.from(
        JSON.stringify({
          entries: [
            {
              word: '勉強',
              readings: ['べんきょう'],
              meanings: ['study'],
              partsOfSpeech: ['noun', 'suru verb'],
              level: 'N5',
            },
            {
              word: '図書館',
              readings: ['としょかん'],
              meanings: ['library'],
              partsOfSpeech: ['noun'],
              level: 'N5',
            },
          ],
          forms: { 勉強する: '勉強' },
        }),
        'utf-8'
      )
    );
    const esCloudV2Payload = gzipSync(
      Buffer.from(
        JSON.stringify({
          entries: [
            {
              word: 'libro',
              readings: ['libro'],
              meanings: ['book'],
              partsOfSpeech: ['noun'],
              level: 'A1',
            },
          ],
          forms: {},
        }),
        'utf-8'
      )
    );

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) {
        return new Response(
          JSON.stringify({
            version: '2.1.0',
            packs: {
              ja: { url: 'ja.json.gz', sizeBytes: jaCloudV2Payload.byteLength, version: '2.1.0' },
              es: { url: 'es.json.gz', sizeBytes: esCloudV2Payload.byteLength, version: '2.1.0' },
            },
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/ja.json.gz')) {
        return new Response(jaCloudV2Payload, { status: 200 });
      }
      if (url.endsWith('/es.json.gz')) {
        return new Response(esCloudV2Payload, { status: 200 });
      }
      if (url.startsWith('/packs/')) {
        const diskPath = path.resolve(process.cwd(), 'public', url.replace(/^\//, ''));
        if (fs.existsSync(diskPath)) {
          return new Response(fs.readFileSync(diskPath), { status: 200 });
        }
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const progressStages: string[] = [];
    const jaRes = await installAllIncludedPacksForLanguage('ja', {
      mode: 'auto',
      skipRemoteManifest: true,
      onProgress: (p) => progressStages.push(p.stage),
    });

    assert.equal(jaRes.installedCount, 4);
    assert.equal(
      progressStages.some((s) => s.includes('Installing 1 of 4:')),
      true
    );
    assert.equal(
      progressStages.some((s) => s.includes('Installing 4 of 4:')),
      true
    );

    // Check order: core-dict -> kanji-levels -> examples -> frequency
    assert.deepEqual(jaRes.packIds, [
      'default-ja-core-dict',
      'default-ja-kanji-levels',
      'default-ja-examples',
      'default-ja-frequency',
    ]);

    // Verify Kanji entries imported from ja-kanji-levels.csv
    const kanjiCount = await db.kanjiEntries.count();
    assert.equal(kanjiCount >= 50, true);
    const manabu = await db.kanjiEntries.get('学');
    assert.ok(manabu);
    assert.equal(manabu.jlptLevel, 'N5');

    // Verify Frequency overlay from ja-frequency.csv applied to 勉強
    const benkyouItems = await db.jmdictEntries
      .where('forms')
      .equals('勉強')
      .filter((r) => r.languageCode === 'ja' && !r.kinds?.includes('sentences'))
      .toArray();
    assert.equal(benkyouItems.length >= 1, true);
    assert.ok(benkyouItems[0].frequencyRank && benkyouItems[0].frequencyRank > 0);

    // Verify Japanese lookup merges imported examples from ja-examples.csv!
    const jaPack = getLanguagePack('ja');
    const jaLookup = await jaPack.lookup('勉強');
    assert.ok(jaLookup);
    assert.ok(jaLookup.examples && jaLookup.examples.length >= 1);
    assert.equal(
      jaLookup.examples.some((ex) => ex.original.includes('勉強')),
      true
    );

    // Install Spanish bundle and verify es-examples.csv attaches to `libro`!
    const esRes = await installAllIncludedPacksForLanguage('es', {
      mode: 'auto',
      skipRemoteManifest: true,
    });
    assert.equal(esRes.installedCount, 2);
    const esPack = getLanguagePack('es');
    const esLookup = await esPack.lookup('libro');
    assert.ok(esLookup);
    assert.ok(esLookup.examples && esLookup.examples.length >= 1);
    assert.equal(
      esLookup.examples.some((ex) => ex.original.toLowerCase().includes('libro')),
      true
    );

    // Install All Available Language Packs (subset with AbortController cancellation check)
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    let caughtAbort = false;
    try {
      await installAllAvailableLanguagePacks({
        languageIds: ['de', 'fr'],
        signal: abortCtrl.signal,
        skipRemoteManifest: true,
      });
    } catch (err) {
      caughtAbort = isAbortError(err);
    }
    assert.equal(caughtAbort, true);

    const batchRes = await installAllAvailableLanguagePacks({
      languageIds: ['es', 'de'],
      mode: 'auto',
      skipRemoteManifest: true,
    });
    assert.deepEqual(batchRes.languagesInstalled, ['es', 'de']);
    assert.equal(batchRes.totalPacksInstalled, 4);

    // -------------------------------------------------------------------------
    // 5. Developer Options Registry: Add File/URL, Remove + Clear DB, Restore Defaults
    // -------------------------------------------------------------------------
    const customCsv = 'word,reading,meaning,level\n新幹線,しんかんせん,bullet train,N4\n';
    const previewRes = await previewCsvOrTsvForDeveloper('common-dict', customCsv, 'ja-extra.csv');
    assert.equal(previewRes.detection.autoDetected, true);

    const addedFilePack = await addCustomBundledPackFromFile({
      languageId: 'ja',
      category: 'common-dict',
      title: 'Japanese Travel Extra',
      fileName: 'ja-extra.csv',
      data: customCsv,
      columnMapping: previewRes.detection.mapping,
    });
    assert.equal(addedFilePack.origin, 'custom');

    const addedUrlPack = await addCustomBundledPackByUrl({
      languageId: 'ko',
      category: 'common-dict',
      title: 'Korean Custom URL Pack',
      url: '/packs/ko-common.csv',
    });
    assert.equal(addedUrlPack.sourceType, 'public-file');

    // Verify custom pack is stored in db.customPackAssets & installed into IndexedDB
    const savedAsset = await db.customPackAssets.get(addedFilePack.id);
    assert.ok(savedAsset);

    await installAllIncludedPacksForLanguage('ja', {
      mode: 'auto',
      skipRemoteManifest: true,
    });

    const shinkansenLookup = await jaPack.lookup('新幹線');
    assert.ok(shinkansenLookup);
    assert.equal(shinkansenLookup.meanings.includes('bullet train'), true);

    // Remove custom pack WITH clearDbEntries: true
    await removeBundledPackFromRegistry(addedFilePack.id, { clearDbEntries: true });
    assert.equal(await db.customPackAssets.get(addedFilePack.id), undefined);
    const shinkansenAfterClear = await db.jmdictEntries
      .where('forms')
      .equals('新幹線')
      .filter((r) => r.languageCode === 'ja')
      .count();
    assert.equal(shinkansenAfterClear, 0);

    // Remove default pack (`default-ja-frequency`) and verify it disappears from active bundle
    await removeBundledPackFromRegistry('default-ja-frequency', { clearDbEntries: true });
    const jaIncludedAfterRemoval = await getIncludedPacksForLanguage('ja', {
      skipRemoteManifest: true,
    });
    assert.equal(
      jaIncludedAfterRemoval.some((p) => p.id === 'default-ja-frequency'),
      false
    );
    const installedBundleStatus = await getInstalledBundledPacksMap();
    assert.equal(installedBundleStatus['default-ja-frequency'], undefined);

    // Add another custom pack and verify Full Backup + Restore preserves customizations & custom assets
    const customTsvPack = await addCustomBundledPackFromFile({
      languageId: 'ja',
      category: 'common-dict',
      title: 'Backup Test TSV',
      fileName: 'backup-test.tsv',
      data: new TextEncoder().encode('word\tmeaning\n桜\tcherry blossom\n'),
    });

    const backupJson = await exportFullBackup();
    const parsedBackup = JSON.parse(backupJson);
    assert.equal(Array.isArray(parsedBackup.customPackAssets), true);
    assert.equal(parsedBackup.customPackAssets.length, 1);

    // Wipe DB and restore from backup
    await db.customPackAssets.clear();
    await restoreDefaultBundledPacks();
    await restoreFromBackup(backupJson);

    const restoredCustomizations = await getBundledPacksCustomizations();
    assert.equal(restoredCustomizations.removedIds.includes('default-ja-frequency'), true);
    assert.equal(
      restoredCustomizations.customPacks.some((p) => p.id === customTsvPack.id),
      true
    );
    const restoredAsset = await db.customPackAssets.get(customTsvPack.id);
    assert.ok(restoredAsset);

    // Finally, Restore Default Packs resets everything cleanly
    await restoreDefaultBundledPacks();
    const effectiveAfterRestore = await getEffectiveBundledPacks({ skipRemoteManifest: true });
    assert.equal(effectiveAfterRestore.removedDefaultIds.length, 0);
    assert.equal(
      effectiveAfterRestore.packs.some((p) => p.id === 'default-ja-frequency'),
      true
    );
    assert.equal(
      effectiveAfterRestore.packs.some((p) => p.origin === 'custom'),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('ALL PHASE 4 BUNDLED PACKS TESTS PASSED!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
