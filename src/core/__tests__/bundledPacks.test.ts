import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import { db } from '../../db/db';
import {
  detectCategoryColumnMapping,
  detectTabularDelimiter,
  extractDictRowsFromTable,
  extractExampleRowsFromTable,
  extractFrequencyRowsFromTable,
  extractKanjiRowsFromTable,
  parseDelimitedPackTable,
  parseRfcDelimitedText,
  stripUtf8Bom,
} from '../packCsvParser';
import {
  detectAndDecodePackContent,
  detectTextContentFormat,
  looksLikeHtmlContent,
  PackLoadError,
} from '../packFormatDetector';
import { getInstalledLanguageIds } from '../packManager';
import {
  DEFAULT_BUNDLED_PACKS,
  INSTALLED_BUNDLED_PACKS_KEY,
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
  retryFailedBundledPacks,
  runBundledPacksCheck,
  type BundledPackDefinition,
} from '../bundledPacks';
import { exportFullBackup, restoreFromBackup } from '../backup';
import { getLanguagePack } from '../../packs/registry';

async function runTests() {
  console.log('--- Running Phase 4 Bundled Packs, Format Detection, Resilience & Deduplication Tests ---');

  await db.delete();
  await db.open();

  // -------------------------------------------------------------------------
  // 1. RFC-4180 CSV / TSV / Semicolon Parser & Content Format Detector
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

  // Semicolon-delimited detection
  const semiCsv = 'word;reading;meaning\n猫;ねこ;cat\n犬;いぬ;dog\n';
  assert.equal(detectTabularDelimiter(semiCsv), ';');

  // Comma CSV containing semicolons inside quotes must still detect ','
  const commaWithSemi = 'character,level,meanings\n"亜","N1","Asia; rank next; come after"\n"腕","N1","arm; ability; talent"\n';
  assert.equal(detectTabularDelimiter(commaWithSemi), ',');

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

  // TSV parsing & unknown header fallback
  const unknownTsv = '水\tmizu\twater\n火\thi\tfire\n';
  const unknownTable = parseDelimitedPackTable(unknownTsv, 'custom.tsv', 'core-dict');
  assert.equal(unknownTable.delimiter, '\t');
  assert.equal(unknownTable.hasHeaderRow, false);
  const unknownDetection = detectCategoryColumnMapping('core-dict', unknownTable);
  assert.equal(unknownDetection.autoDetected, false);
  assert.equal(unknownDetection.missingRequired.includes('word'), true);

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

  // Kanji levels CSV extraction
  const kanjiCsv = 'character,jlpt,meaning,onyomi,kunyomi,strokes\n学,5,"study; learning",ガク,まな.ぶ,8\n強,N4,"strong",キョウ,つよ.い,11\n';
  const kanjiTable = parseDelimitedPackTable(kanjiCsv, 'ja-kanji.csv', 'kanji-levels');
  const kanjiRows = extractKanjiRowsFromTable(kanjiTable, 'ja-kanji.csv');
  assert.equal(kanjiRows.length, 2);
  assert.equal(kanjiRows[0].jlptLevel, 'N5');
  assert.equal(kanjiRows[1].jlptLevel, 'N4');
  assert.equal(kanjiRows[0].strokeCount, 8);

  // Frequency CSV: Word,Form,Rank + single-column rank fallback
  const freqWithForm = 'Word,Form,Rank\nの,の,1\n食べる,食べる,42\n';
  const freqFormTable = parseDelimitedPackTable(freqWithForm, 'ja-frequency_list_global.json', 'frequency');
  const freqFormRows = extractFrequencyRowsFromTable(freqFormTable);
  assert.deepEqual(freqFormRows, [
    { word: 'の', rank: 1 },
    { word: '食べる', rank: 42 },
  ]);

  const freqSingle = 'word\nの\nに\n勉強\n';
  const freqSingleTable = parseDelimitedPackTable(freqSingle, 'ja-freq.csv', 'frequency');
  const freqSingleRows = extractFrequencyRowsFromTable(freqSingleTable);
  assert.deepEqual(freqSingleRows, [
    { word: 'の', rank: 1 },
    { word: 'に', rank: 2 },
    { word: '勉強', rank: 3 },
  ]);

  // Content detector tests: BOM bytes, gzip, zip, HTML, JSONL, mismatch warning
  const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('character,level\n亜,N1\n', 'utf-8')]);
  const detectedCsvInJson = await detectAndDecodePackContent(new Uint8Array(bomBytes), {
    packTitle: 'Japanese Kanji Levels',
    filePath: '/packs/ja-kanji-n1.json',
    httpStatus: 200,
  });
  assert.equal(detectedCsvInJson.format, 'csv');
  assert.equal(detectedCsvInJson.mismatchWarning, 'Japanese Kanji Levels (ja-kanji-n1.json): detected CSV, expected JSON');

  // Gzipped JSONL
  const jsonlPayload = '{"word":"猫","meanings":["cat"]}\n{"word":"犬","meanings":["dog"]}\n';
  const gzJsonl = gzipSync(Buffer.from(jsonlPayload, 'utf-8'));
  const detectedJsonl = await detectAndDecodePackContent(new Uint8Array(gzJsonl), {
    packTitle: 'Test JSONL',
    filePath: '/packs/test.jsonl.gz',
    httpStatus: 200,
  });
  assert.equal(detectedJsonl.format, 'jsonl');

  // Zipped CSV
  const zip = new JSZip();
  zip.file('data.csv', 'word,meaning\n鳥,bird\n');
  const zipBuf = await zip.generateAsync({ type: 'uint8array' });
  const detectedZip = await detectAndDecodePackContent(zipBuf, {
    packTitle: 'Zipped CSV',
    filePath: '/packs/test.zip',
    httpStatus: 200,
  });
  assert.equal(detectedZip.format, 'csv');
  assert.equal(detectedZip.text.includes('鳥'), true);

  // HTML fallback -> "File not found on server: <path>"
  assert.equal(looksLikeHtmlContent('<!doctype html><html><body>SPA</body></html>'), true);
  let htmlErr: any = null;
  try {
    await detectAndDecodePackContent(
      new TextEncoder().encode('<!DOCTYPE html><html><head><title>App</title></head></html>'),
      {
        packTitle: 'Missing Pack',
        filePath: '/packs/missing.json',
        httpStatus: 200,
      }
    );
  } catch (err) {
    htmlErr = err;
  }
  assert.ok(htmlErr instanceof PackLoadError);
  assert.equal(htmlErr.message.includes('File not found on server: /packs/missing.json'), true);
  assert.equal(htmlErr.message.includes('Missing Pack'), true);
  assert.equal(htmlErr.message.includes('HTTP 200'), true);
  assert.equal(detectTextContentFormat('{"a":1}').format, 'json');

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

  assert.equal(classifyDiscoveredPackPath('/public/packs/README.txt'), null);
  assert.equal(classifyDiscoveredPackPath('/public/packs/base.dat.gz'), null);

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
  const jaKanjiCount = mergedBase.filter(
    (p) => p.languageId === 'ja' && p.category === 'kanji-levels'
  ).length;
  assert.equal(jaKanjiCount, 1);
  assert.equal(
    mergedBase.some((p) => p.languageId === 'ko' && p.category === 'common-dict'),
    true
  );

  // -------------------------------------------------------------------------
  // 3. Verify Real Public Files & jmdict-simplified + Real Pack Check
  // -------------------------------------------------------------------------
  const publicPacksDir = path.resolve(process.cwd(), 'public/packs');
  for (const file of [
    'ja-kanji-levels.csv',
    'ja-examples.csv',
    'ja-frequency.csv',
    'ja-kanji-n1.json',
    'ja-jlpt-kanji.json',
    'ja-frequency_list_global.json',
    'ja-jmdict-eng-common-3.6.2.json',
    'ja-jmdict-examples.json.gz',
    'es-examples.csv',
    'de-examples.csv',
    'fr-examples.csv',
  ]) {
    const fullPath = path.join(publicPacksDir, file);
    assert.equal(fs.existsSync(fullPath), true, `Expected ${file} in public/packs/`);
  }

  // -------------------------------------------------------------------------
  // 4. Mock Fetch + Resilient Install All + Deduplication + Pack Check
  // -------------------------------------------------------------------------
  const originalFetch = globalThis.fetch;
  try {
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

    const brokenUrls = new Set<string>();
    const jmdictSimplifiedSample = JSON.stringify({
      words: [
        {
          id: '1000',
          kanji: [{ text: '猫', common: true, tags: ['ichi1'] }],
          kana: [{ text: 'ねこ', common: true, tags: ['ichi1'] }],
          sense: [
            {
              partOfSpeech: ['n'],
              gloss: [
                { lang: 'eng', text: 'cat' },
                { lang: 'ger', text: 'Katze' },
              ],
            },
          ],
        },
      ],
    });
    const jmdictExamplesSample = gzipSync(
      Buffer.from(
        JSON.stringify({
          words: [
            {
              id: '2000',
              kanji: [{ text: '猫' }],
              kana: [{ text: 'ねこ' }],
              sense: [
                {
                  gloss: [{ lang: 'eng', text: 'cat' }],
                  examples: [
                    {
                      text: '猫',
                      sentences: [
                        { lang: 'jpn', text: '猫が寝ています。' },
                        { lang: 'eng', text: 'The cat is sleeping.' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        'utf-8'
      )
    );

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (brokenUrls.has(url)) {
        return new Response('<!doctype html><html>404</html>', { status: 404 });
      }
      if (url.endsWith('/manifest.json')) {
        return new Response(
          JSON.stringify({
            version: '2.1.0',
            packs: {
              ja: { file: 'ja.json.gz', sizeBytes: jaCloudV2Payload.byteLength, version: '2.1.0' },
              es: { file: 'es.json.gz', sizeBytes: esCloudV2Payload.byteLength, version: '2.1.0' },
              de: { file: 'de.json.gz', sizeBytes: esCloudV2Payload.byteLength, version: '2.1.0' },
            },
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/ja.json.gz')) {
        return new Response(jaCloudV2Payload, { status: 200 });
      }
      if (url.endsWith('/es.json.gz') || url.endsWith('/de.json.gz')) {
        return new Response(esCloudV2Payload, { status: 200 });
      }
      if (url === '/packs/test-jmdict-common.json') {
        return new Response(jmdictSimplifiedSample, { status: 200 });
      }
      if (url === '/packs/test-jmdict-examples.json.gz') {
        return new Response(jmdictExamplesSample, { status: 200 });
      }
      if (url.startsWith('/packs/')) {
        const diskPath = path.resolve(process.cwd(), 'public', url.replace(/^\//, ''));
        if (fs.existsSync(diskPath)) {
          return new Response(fs.readFileSync(diskPath), { status: 200 });
        }
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    // 4a. Test Pack Check against real public/packs/ files (first 100 rows each!)
    const realFilesToCheck: BundledPackDefinition[] = [
      {
        id: 'chk-n1',
        languageId: 'ja',
        category: 'kanji-levels',
        title: 'Japanese Kanji N1',
        sourceType: 'public-file',
        fileFormat: 'json',
        url: '/packs/ja-kanji-n1.json',
        origin: 'auto-discovered',
      },
      {
        id: 'chk-jlpt-kanji',
        languageId: 'ja',
        category: 'kanji-levels',
        title: 'Japanese JLPT Kanji JSON',
        sourceType: 'public-file',
        fileFormat: 'json',
        url: '/packs/ja-jlpt-kanji.json',
        origin: 'auto-discovered',
      },
      {
        id: 'chk-freq-global',
        languageId: 'ja',
        category: 'frequency',
        title: 'Japanese Frequency Global',
        sourceType: 'public-file',
        fileFormat: 'json',
        url: '/packs/ja-frequency_list_global.json',
        origin: 'auto-discovered',
      },
      {
        id: 'chk-jmdict-common',
        languageId: 'ja',
        category: 'common-dict',
        title: 'JMdict Common',
        sourceType: 'public-file',
        fileFormat: 'json',
        url: '/packs/test-jmdict-common.json',
        origin: 'auto-discovered',
      },
      {
        id: 'chk-jmdict-examples',
        languageId: 'ja',
        category: 'examples',
        title: 'JMdict Examples GZ',
        sourceType: 'public-file',
        fileFormat: 'json',
        url: '/packs/test-jmdict-examples.json.gz',
        origin: 'auto-discovered',
      },
      {
        id: 'chk-missing',
        languageId: 'ja',
        category: 'examples',
        title: 'Missing Pack',
        sourceType: 'public-file',
        fileFormat: 'csv',
        url: '/packs/does-not-exist.csv',
        origin: 'custom',
      },
    ];

    const checkRows = await runBundledPacksCheck(realFilesToCheck, { maxRows: 100 });
    assert.equal(checkRows.length, 6);

    const n1Check = checkRows.find((r) => r.packId === 'chk-n1')!;
    assert.equal(n1Check.status, 'warning'); // CSV inside .json warns cleanly AND finds rows!
    assert.equal(n1Check.detectedFormat, 'CSV');
    assert.equal(n1Check.rowsFound, 100);
    assert.equal(n1Check.problem.includes('detected CSV, expected JSON'), true);

    const jlptJsonCheck = checkRows.find((r) => r.packId === 'chk-jlpt-kanji')!;
    assert.equal(jlptJsonCheck.status, 'ok');
    assert.equal(jlptJsonCheck.detectedFormat, 'JSON');
    assert.equal(jlptJsonCheck.rowsFound, 100);

    const freqCheck = checkRows.find((r) => r.packId === 'chk-freq-global')!;
    assert.equal(freqCheck.status, 'warning'); // Word,Form,Rank CSV inside .json
    assert.equal(freqCheck.detectedFormat, 'CSV');
    assert.equal(freqCheck.rowsFound, 100);

    const commonCheck = checkRows.find((r) => r.packId === 'chk-jmdict-common')!;
    assert.equal(commonCheck.status, 'ok');
    assert.equal(commonCheck.rowsFound, 1);

    const exCheck = checkRows.find((r) => r.packId === 'chk-jmdict-examples')!;
    assert.equal(exCheck.status, 'ok');
    assert.equal(exCheck.rowsFound, 1);

    const missingCheck = checkRows.find((r) => r.packId === 'chk-missing')!;
    assert.equal(missingCheck.status, 'error');
    assert.equal(missingCheck.httpStatus, 404);
    assert.equal(missingCheck.problem.includes('/packs/does-not-exist.csv'), true);

    // 4b. Test Sequential Install All for Japanese & Lookup Integration
    const progressStages: string[] = [];
    const jaRes = await installAllIncludedPacksForLanguage('ja', {
      mode: 'auto',
      skipRemoteManifest: true,
      onProgress: (p) => progressStages.push(p.stage),
    });

    assert.equal(jaRes.installedCount, 4);
    assert.equal(jaRes.languageStatus, 'installed');
    assert.equal(
      progressStages.some((s) => s.includes('Installing 1 of 4:')),
      true
    );
    assert.equal(
      progressStages.some((s) => s.includes('Installing 4 of 4:')),
      true
    );
    assert.deepEqual(jaRes.packIds, [
      'default-ja-core-dict',
      'default-ja-kanji-levels',
      'default-ja-examples',
      'default-ja-frequency',
    ]);

    const kanjiCount = await db.kanjiEntries.count();
    assert.equal(kanjiCount >= 50, true);
    const manabu = await db.kanjiEntries.get('学');
    assert.ok(manabu);
    assert.equal(manabu.jlptLevel, 'N5');

    const benkyouItems = await db.jmdictEntries
      .where('forms')
      .equals('勉強')
      .filter((r) => r.languageCode === 'ja' && !r.kinds?.includes('sentences'))
      .toArray();
    assert.equal(benkyouItems.length >= 1, true);
    assert.ok(benkyouItems[0].frequencyRank && benkyouItems[0].frequencyRank > 0);

    const jaPack = getLanguagePack('ja');
    const jaLookup = await jaPack.lookup('勉強');
    assert.ok(jaLookup);
    assert.ok(jaLookup.examples && jaLookup.examples.length >= 1);
    assert.equal(
      jaLookup.examples.some((ex) => ex.original.includes('勉強')),
      true
    );

    // 4c. Deduplication Test 1: common-dict is skipped and marked 'covered' when cloud core-dict is installed
    const extraCommonPack = await addCustomBundledPackByUrl({
      languageId: 'ja',
      category: 'common-dict',
      title: 'JMdict Common Subset',
      url: '/packs/test-jmdict-common.json',
    });
    const jaReinstallRes = await installAllIncludedPacksForLanguage('ja', {
      mode: 'auto',
      skipRemoteManifest: true,
    });
    const coveredSkip = jaReinstallRes.skippedPacks.find((s) => s.pack.id === extraCommonPack.id);
    assert.ok(coveredSkip);
    assert.equal(coveredSkip.reason, 'covered');
    const bundleMapAfterCover = await getInstalledBundledPacksMap();
    assert.equal(bundleMapAfterCover[extraCommonPack.id]?.status, 'covered');
    await removeBundledPackFromRegistry(extraCommonPack.id, { clearDbEntries: true });

    // Deduplication Test 2: common-dict IS NOT skipped if core-dict only installed offline starter!
    await removeBundledPackFromRegistry('default-ja-core-dict', { clearDbEntries: true }).catch(() => {});
    await restoreDefaultBundledPacks();
    await db.settings.delete(INSTALLED_BUNDLED_PACKS_KEY);
    await db.jmdictEntries.clear();
    await db.imports.clear();
    await db.installedPacks.clear();

    const starterCommonPack = await addCustomBundledPackByUrl({
      languageId: 'ja',
      category: 'common-dict',
      title: 'JMdict Common Starter Complement',
      url: '/packs/test-jmdict-common.json',
    });
    const jaStarterRes = await installAllIncludedPacksForLanguage('ja', {
      mode: 'starter',
      skipRemoteManifest: true,
    });
    assert.equal(
      jaStarterRes.packIds.includes(starterCommonPack.id),
      true,
      'common-dict must NOT be skipped when core-dict only fell back to starter'
    );
    // Verify English-only gloss extraction from jmdict-simplified ('cat', not 'Katze')
    const nekoLookup = await jaPack.lookup('猫');
    assert.ok(nekoLookup);
    assert.equal(nekoLookup.meanings.includes('cat'), true);
    assert.equal(nekoLookup.meanings.includes('Katze'), false);
    await removeBundledPackFromRegistry(starterCommonPack.id, { clearDbEntries: true });

    // 4d. Deduplication Test 3: manual import (imp-*) prevents bundled duplicate unless overwriteManualImports: true
    await db.imports.put({
      importId: 'imp-manual-es-ex',
      languageCode: 'es',
      kind: 'sentences',
      fileName: 'es-examples.csv',
      fileSize: 1024,
      fingerprint: 'manual-fp',
      date: Date.now(),
      entryCount: 500,
      version: '1.0',
    });
    const esManualSkipRes = await installAllIncludedPacksForLanguage('es', {
      mode: 'auto',
      skipRemoteManifest: true,
    });
    assert.equal(
      esManualSkipRes.skippedPacks.some((s) => s.reason === 'manual-duplicate'),
      true
    );
    const esManualOverwriteRes = await installAllIncludedPacksForLanguage('es', {
      mode: 'auto',
      overwriteManualImports: true,
      skipRemoteManifest: true,
    });
    assert.equal(
      esManualOverwriteRes.skippedPacks.some((s) => s.reason === 'manual-duplicate'),
      false
    );
    assert.equal(esManualOverwriteRes.installedCount, 2);

    // 4e. Resilient Batch Install + Partial Language Status + Retry Failed
    brokenUrls.add('/packs/de-examples.csv');
    // Also simulate Spanish cloud failure in cloud-strict mode while es-examples succeeds -> partial!
    brokenUrls.add('https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@v2.1/packs/es.json.gz');
    await db.installedPacks.clear();
    await db.settings.delete(INSTALLED_BUNDLED_PACKS_KEY);

    const resilientBatch = await installAllAvailableLanguagePacks({
      languageIds: ['es', 'de'],
      mode: 'cloud-strict',
      overwriteManualImports: true,
      skipRemoteManifest: true,
    });
    // Batch did NOT abort; de-core-dict + es-examples + fr/etc proceeded!
    assert.equal(resilientBatch.failedPacks.length, 2);
    assert.equal(resilientBatch.summaryText.includes('failed:'), true);
    // 'es' lost its required core-dict while es-examples succeeded -> partial!
    assert.equal(resilientBatch.partialLanguages.includes('es'), true);
    assert.equal(resilientBatch.languagesInstalled.includes('es'), false);
    const installedIdsAfterPartial = await getInstalledLanguageIds();
    assert.equal(installedIdsAfterPartial.includes('es'), false);
    assert.equal(installedIdsAfterPartial.includes('de'), true);

    // Fix broken URLs and Retry Failed
    brokenUrls.clear();
    const retryRes = await retryFailedBundledPacks(resilientBatch.failedPacks, {
      mode: 'auto',
      overwriteManualImports: true,
    });
    assert.equal(retryRes.failedPacks.length, 0);
    assert.equal(retryRes.totalPacksInstalled, 2);
    const installedIdsAfterRetry = await getInstalledLanguageIds();
    assert.equal(installedIdsAfterRetry.includes('es'), true);

    // AbortController cancellation still works cleanly
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

    const savedAsset = await db.customPackAssets.get(addedFilePack.id);
    assert.ok(savedAsset);

    await db.settings.delete(INSTALLED_BUNDLED_PACKS_KEY);
    await db.imports.clear();
    await installAllIncludedPacksForLanguage('ja', {
      mode: 'starter',
      skipRemoteManifest: true,
    });

    const shinkansenLookup = await jaPack.lookup('新幹線');
    assert.ok(shinkansenLookup);
    assert.equal(shinkansenLookup.meanings.includes('bullet train'), true);

    await removeBundledPackFromRegistry(addedFilePack.id, { clearDbEntries: true });
    assert.equal(await db.customPackAssets.get(addedFilePack.id), undefined);
    const shinkansenAfterClear = await db.jmdictEntries
      .where('forms')
      .equals('新幹線')
      .filter((r) => r.languageCode === 'ja')
      .count();
    assert.equal(shinkansenAfterClear, 0);

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
