import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getAllLanguagePacks } from '../../packs/registry';
import {
  db,
  type DownloadedPackAsset,
  getDictionaryMeta,
  getImports,
  deleteImportInBatches,
  reindexEnglishGlosses,
  clearAllLanguageData,
  clearUserStudyData,
  type DictionaryMetaItem,
  type ImportRecord,
  type ImportKind,
  type KanjiEntryItem,
} from '../../db/db';
import {
  getKuromojiCacheStatus,
  installKuromojiOffline,
  deleteKuromojiOfflineCache,
} from '../../packs/japanese/tokenizer';
import { JAPANESE_DICTIONARY_SAMPLE } from '../../packs/japanese/dictionaryData';
import {
  parseKanjiListTable,
  buildKanjiPreviewRows,
  type ParsedKanjiTable,
  type KanjiColumnMapping,
} from '../../packs/japanese/kanjiListParser';
import JSZip from 'jszip';
import { useAppStore } from '../../store/useAppStore';
import { logEvent } from '../../core/eventLogger';
import {
  Package,
  CheckCircle2,
  DownloadCloud,
  Trash2,
  HardDrive,
  Award,
  Mic,
  Volume2,
  Camera,
  Check,
  AlertCircle,
  Upload,
  BookOpen,
  X,
  Loader2,
  Database,
  Globe,
  Sparkles,
  Info,
  Lock,
  RefreshCw,
  FileText,
  Layers,
  ShieldCheck,
  AlertTriangle,
  BarChart3,
} from 'lucide-react';

export const LanguagePacksView: React.FC = () => {
  const { activeLanguageId, setActiveLanguage } = useAppStore();
  const allPacks = getAllLanguagePacks();

  // Storage and asset states
  const [downloadedAssets, setDownloadedAssets] = useState<Record<string, DownloadedPackAsset>>({});
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [isDownloading, setIsDownloading] = useState<Record<string, boolean>>({});

  // Kuromoji offline cache state
  const [kuromojiCache, setKuromojiCache] = useState<{
    isInstalled: boolean;
    fileCount: number;
    sizeBytes: number;
  }>({ isInstalled: false, fileCount: 0, sizeBytes: 0 });
  const [isInstallingKuromoji, setIsInstallingKuromoji] = useState(false);
  const [kuromojiProgress, setKuromojiProgress] = useState(0);

  // JMdict dictionary pack state
  const [dictMeta, setDictMeta] = useState<DictionaryMetaItem | null>(null);
  const [actualJmdictCount, setActualJmdictCount] = useState<number>(0);
  const [isLoadingMeta, setIsLoadingMeta] = useState(true);

  // Multi-import records list (Requirement 1 & 7)
  const [importsList, setImportsList] = useState<ImportRecord[]>([]);

  // Kanji data status and inspection test box (Requirement 2)
  const [storedKanjiCount, setStoredKanjiCount] = useState<number>(0);
  const [kanjiLevelsBreakdown, setKanjiLevelsBreakdown] = useState<
    Record<'N5' | 'N4' | 'N3' | 'N2' | 'N1' | 'unlisted', number>
  >({
    N5: 0,
    N4: 0,
    N3: 0,
    N2: 0,
    N1: 0,
    unlisted: 0,
  });
  const [kanjiSearchChar, setKanjiSearchChar] = useState('');
  const [kanjiSearchResult, setKanjiSearchResult] = useState<KanjiEntryItem | null | undefined>(undefined);
  const [isSearchingKanji, setIsSearchingKanji] = useState(false);

  // Storage info
  const [storageEstimate, setStorageEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [studyStats, setStudyStats] = useState<{
    cards: number;
    lookups: number;
    docs: number;
    words: number;
  }>({ cards: 0, lookups: 0, docs: 0, words: 0 });

  // Import modal state
  const [showImportModal, setShowImportModal] = useState(false);
  const [importTab, setImportTab] = useState<'upload' | 'url' | 'sample'>('upload');
  const [selectedKind, setSelectedKind] = useState<ImportKind>('dictionary');
  const [urlInput, setUrlInput] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importStatusMessage, setImportStatusMessage] = useState('');
  const [importProgress, setImportProgress] = useState(0);
  const [importProcessed, setImportProcessed] = useState(0);
  const [importTotal, setImportTotal] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);

  // Kanji list preview & column mapping state (Requirement 3)
  const [kanjiPreviewFiles, setKanjiPreviewFiles] = useState<
    Array<{
      fileName: string;
      text: string;
      size: number;
      parsed: ParsedKanjiTable;
      mapping: KanjiColumnMapping;
    }>
  >([]);
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);

  // Import Summary modal state (Requirement 2 & 5)
  const [importSummary, setImportSummary] = useState<{
    isOpen: boolean;
    kind: string;
    fileName: string;
    count: number;
    matchedCount?: number;
    unmatchedCount?: number;
    ambiguousCount?: number;
    unmatchedSample?: any[];
    ambiguousSample?: any[];
    perLevelCounts?: Record<string, number>;
    duplicateCount?: number;
    skippedCount?: number;
  } | null>(null);

  // Duplicate prompt modal state (Requirement 2)
  const [duplicatePrompt, setDuplicatePrompt] = useState<{
    isOpen: boolean;
    existingImport: ImportRecord;
    pendingPayload: any;
  } | null>(null);

  // Confirmation / Deletion modal state
  const [deleteModal, setDeleteModal] = useState<{
    isOpen: boolean;
    mode: 'import' | 'allLanguage' | 'studyData';
    targetImport?: ImportRecord;
    title: string;
    message: string;
    submessage?: string;
    inProgress: boolean;
    progressPct: number;
    progressText: string;
  }>({
    isOpen: false,
    mode: 'import',
    title: '',
    message: '',
    inProgress: false,
    progressPct: 0,
    progressText: '',
  });

  // Re-indexing modal state
  const [reindexState, setReindexState] = useState<{
    isOpen: boolean;
    inProgress: boolean;
    progressPct: number;
    statusText: string;
    result?: string;
  }>({
    isOpen: false,
    inProgress: false,
    progressPct: 0,
    statusText: '',
  });

  const workerRef = useRef<Worker | null>(null);

  // Load all live status values from IndexedDB and Cache Storage
  const loadAllStatuses = useCallback(async () => {
    setIsLoadingMeta(true);
    try {
      // 1. Downloaded assets records
      const items = await db.downloadedAssets.toArray();
      const map: Record<string, DownloadedPackAsset> = {};
      for (const item of items) {
        map[`${item.packId}:${item.assetId}`] = item;
      }
      setDownloadedAssets(map);

      // 2. Kuromoji Cache Storage check
      const kCache = await getKuromojiCacheStatus();
      setKuromojiCache(kCache);

      // 3. JMdict real table count & metadata
      const count = await db.jmdictEntries.where('languageCode').equals('ja').count();
      setActualJmdictCount(count);
      const meta = await getDictionaryMeta('ja');
      setDictMeta(meta);

      // 4. Multi-pack imports table
      const allImports = await getImports();
      setImportsList(allImports);

      // 4b. Stored Kanji counts & breakdown (Requirement 2)
      try {
        const kanjiEntries = await db.kanjiEntries.toArray();
        setStoredKanjiCount(kanjiEntries.length);
        const kBreakdown = { N5: 0, N4: 0, N3: 0, N2: 0, N1: 0, unlisted: 0 };
        for (const k of kanjiEntries) {
          if (k.jlptLevel && /^N[1-5]$/i.test(k.jlptLevel)) {
            const lvl = k.jlptLevel.toUpperCase() as keyof typeof kBreakdown;
            kBreakdown[lvl] = (kBreakdown[lvl] || 0) + 1;
          } else {
            kBreakdown.unlisted++;
          }
        }
        setKanjiLevelsBreakdown(kBreakdown);
      } catch (e) {
        console.warn('Failed to load kanji entries count:', e);
      }

      // 5. navigator.storage.estimate
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
        try {
          const est = await navigator.storage.estimate();
          setStorageEstimate({
            usage: est.usage || 0,
            quota: est.quota || 0,
          });
        } catch (e) {
          console.warn('Storage estimate error:', e);
        }
      }

      // 6. User study data stats
      const [cards, lookups, docs, words] = await Promise.all([
        db.cards.count(),
        db.lookups.count(),
        db.documents.count(),
        db.wordStatuses.count(),
      ]);
      setStudyStats({ cards, lookups, docs, words });
    } catch (err) {
      console.error('Failed to load pack statuses:', err);
    } finally {
      setIsLoadingMeta(false);
    }
  }, []);

  useEffect(() => {
    loadAllStatuses();
  }, [loadAllStatuses]);

  // Live inspection query for "Look up a kanji" test box (Requirement 2)
  useEffect(() => {
    const raw = kanjiSearchChar.normalize('NFC').trim();
    if (!raw) {
      setKanjiSearchResult(undefined);
      return;
    }
    const char = Array.from(raw)[0];
    let cancelled = false;
    setIsSearchingKanji(true);
    db.kanjiEntries
      .get(char)
      .then((entry) => {
        if (!cancelled) {
          setKanjiSearchResult(entry || null);
          setIsSearchingKanji(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('Kanji lookup test box error:', err);
          setKanjiSearchResult(null);
          setIsSearchingKanji(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [kanjiSearchChar, storedKanjiCount]);

  // Handle Kuromoji and generic asset downloads
  const handleDownloadAsset = async (packId: string, asset: any) => {
    const key = `${packId}:${asset.id}`;

    if (asset.id === 'kuromoji-dict') {
      setIsInstallingKuromoji(true);
      setKuromojiProgress(0);
      try {
        const totalBytes = await installKuromojiOffline((pct) => {
          setKuromojiProgress(pct);
        });
        await db.downloadedAssets.put({
          packId,
          assetId: asset.id,
          name: asset.name,
          version: asset.version,
          sizeBytes: totalBytes,
          installedAt: Date.now(),
        });
        await logEvent('kuromoji_cached', { totalBytes });
      } catch (err: any) {
        console.error('Failed to cache Kuromoji:', err);
      } finally {
        setIsInstallingKuromoji(false);
        await loadAllStatuses();
      }
      return;
    }

    setIsDownloading((prev) => ({ ...prev, [key]: true }));
    setDownloadProgress((prev) => ({ ...prev, [key]: 0 }));

    for (let progress = 10; progress <= 100; progress += 20) {
      await new Promise((r) => setTimeout(r, 100));
      setDownloadProgress((prev) => ({ ...prev, [key]: Math.min(100, progress) }));
    }

    const downloadedItem: DownloadedPackAsset = {
      packId,
      assetId: asset.id,
      name: asset.name,
      version: asset.version,
      sizeBytes: asset.sizeBytes,
      installedAt: Date.now(),
    };

    await db.downloadedAssets.put(downloadedItem);
    await logEvent('pack_asset_downloaded', { packId, assetId: asset.id });

    setIsDownloading((prev) => ({ ...prev, [key]: false }));
    await loadAllStatuses();
  };

  const handleDeleteGenericAsset = async (packId: string, assetId: string) => {
    if (assetId === 'kuromoji-dict') {
      await deleteKuromojiOfflineCache();
    }
    await db.downloadedAssets.where({ packId, assetId }).delete();
    await logEvent('pack_asset_deleted', { packId, assetId });
    await loadAllStatuses();
  };

  // Open confirmation modal for deleting a specific import record (Requirement 4)
  const openDeleteImportModal = (imp: ImportRecord) => {
    const formattedSize =
      imp.fileSize > 1024 * 1024
        ? `${(imp.fileSize / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.round(imp.fileSize / 1024)} KB`;

    setDeleteModal({
      isOpen: true,
      mode: 'import',
      targetImport: imp,
      title: 'Delete Import',
      message: `Remove "${imp.fileName}" (${imp.kind})?`,
      submessage: `This will remove its entries (${imp.entryCount.toLocaleString()} entries, ${formattedSize}) from your offline database. Entries shared with other installed packs will remain intact. Your flashcards, lookup history, and library documents will NOT be deleted.`,
      inProgress: false,
      progressPct: 0,
      progressText: '',
    });
  };

  // Open confirmation modal for clearing all language data
  const openClearAllLanguageModal = () => {
    setDeleteModal({
      isOpen: true,
      mode: 'allLanguage',
      title: 'Clear All Language Data',
      message: 'Remove all imported packs, dictionaries, tokenizers, and caches?',
      submessage: 'All installed language packs across all languages will be removed. The app will revert to the built-in sample dictionaries. Personal study data (flashcards, history, documents) is 100% preserved.',
      inProgress: false,
      progressPct: 0,
      progressText: '',
    });
  };

  // Open confirmation modal for deleting study data
  const openDeleteStudyDataModal = () => {
    setDeleteModal({
      isOpen: true,
      mode: 'studyData',
      title: 'Delete Personal Study Data',
      message: 'Permanently erase your study data (cards, history, documents)?',
      submessage: `This will permanently delete ${studyStats.cards} flashcards, ${studyStats.lookups} reading lookups, and ${studyStats.docs} library texts. Offline dictionaries and language packs will remain intact.`,
      inProgress: false,
      progressPct: 0,
      progressText: '',
    });
  };

  // Execute deletion confirmed by user
  const handleConfirmDelete = async () => {
    setDeleteModal((prev) => ({
      ...prev,
      inProgress: true,
      progressPct: 0,
      progressText: 'Initializing deletion...',
    }));

    try {
      if (deleteModal.mode === 'import' && deleteModal.targetImport) {
        const imp = deleteModal.targetImport;
        await deleteImportInBatches(imp.importId, (pct, processed, total) => {
          setDeleteModal((prev) => ({
            ...prev,
            progressPct: pct,
            progressText: `Cleaning entries: ${processed.toLocaleString()} / ${total.toLocaleString()}`,
          }));
        });
        await logEvent('import_deleted', { importId: imp.importId, kind: imp.kind });
      } else if (deleteModal.mode === 'allLanguage') {
        setDeleteModal((prev) => ({
          ...prev,
          progressPct: 30,
          progressText: 'Clearing all language databases...',
        }));
        await clearAllLanguageData();
        setDeleteModal((prev) => ({
          ...prev,
          progressPct: 100,
          progressText: 'Language data cleared successfully.',
        }));
        await logEvent('all_language_data_cleared', {});
      } else if (deleteModal.mode === 'studyData') {
        setDeleteModal((prev) => ({
          ...prev,
          progressPct: 50,
          progressText: 'Deleting study records...',
        }));
        await clearUserStudyData();
        setDeleteModal((prev) => ({
          ...prev,
          progressPct: 100,
          progressText: 'Study data deleted.',
        }));
        await logEvent('study_data_deleted', {});
      }

      await loadAllStatuses();
      setTimeout(() => {
        setDeleteModal((prev) => ({ ...prev, isOpen: false, inProgress: false }));
      }, 500);
    } catch (err: any) {
      console.error('Deletion error:', err);
      setDeleteModal((prev) => ({
        ...prev,
        inProgress: false,
        progressText: `Error: ${err?.message || 'Deletion failed'}`,
      }));
    }
  };

  // Re-index English glosses handler
  const handleReindex = async (languageCode = 'ja') => {
    setReindexState({
      isOpen: true,
      inProgress: true,
      progressPct: 0,
      statusText: 'Scanning entries for non-English glosses...',
    });

    try {
      const result = await reindexEnglishGlosses(languageCode, (pct, processed, total) => {
        setReindexState((prev) => ({
          ...prev,
          progressPct: pct,
          statusText: `Re-indexing senses: ${processed.toLocaleString()} / ${total.toLocaleString()}`,
        }));
      });

      setReindexState((prev) => ({
        ...prev,
        inProgress: false,
        progressPct: 100,
        statusText: 'Re-index complete!',
        result: `All entries verified. Cleaned ${result.cleanedCount} senses to guarantee English-only definitions.`,
      }));

      await loadAllStatuses();
    } catch (err: any) {
      setReindexState((prev) => ({
        ...prev,
        inProgress: false,
        statusText: `Re-indexing failed: ${err?.message || 'Unknown error'}`,
      }));
    }
  };

  // Start Web Worker import process
  const startImportWorker = (startPayload: any) => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }

    setIsImporting(true);
    setImportProgress(0);
    setImportProcessed(0);
    setImportTotal(0);
    setImportError(null);
    setImportStatusMessage('Spawning dictionary indexer worker...');

    const worker = new Worker(
      new URL('../../packs/japanese/jmdictImporter.worker.ts', import.meta.url),
      { type: 'module' }
    );
    workerRef.current = worker;

    worker.onmessage = async (e: MessageEvent) => {
      const data = e.data || {};

      if (data.type === 'duplicate_fingerprint') {
        setIsImporting(false);
        // Show prompt: "This file is already installed. Replace it?" (Requirement 2)
        setDuplicatePrompt({
          isOpen: true,
          existingImport: data.existingImport,
          pendingPayload: startPayload,
        });
        return;
      }

      if (data.type === 'status') {
        setImportStatusMessage(data.message);
      } else if (data.type === 'progress') {
        setImportProgress(data.percent);
        setImportProcessed(data.processed);
        setImportTotal(data.total);
        setImportStatusMessage(
          `Upserting entries: ${data.processed.toLocaleString()} / ${data.total.toLocaleString()}`
        );
      } else if (data.type === 'complete') {
        setIsImporting(false);
        setImportStatusMessage(
          `Import successful! ${data.count.toLocaleString()} entries indexed.`
        );
        await loadAllStatuses();
        await logEvent('pack_imported', {
          importId: data.importId,
          count: data.count,
          kind: data.kind,
        });
        setShowImportModal(false);
        setKanjiPreviewFiles([]);
        setActivePreviewIndex(0);
        setImportStatusMessage('');

        // Display summary modal with matched/unmatched (for vocab/frequency) or per-level/duplicate/skipped (for kanji-levels)
        setImportSummary({
          isOpen: true,
          kind: data.kind,
          fileName: data.fileName || startPayload.fileName || `${data.kind} dataset`,
          count: data.count,
          matchedCount: data.matchedCount,
          unmatchedCount: data.unmatchedCount,
          ambiguousCount: data.ambiguousCount,
          unmatchedSample: data.unmatchedSample || [],
          ambiguousSample: data.ambiguousSample || [],
          perLevelCounts: data.perLevelCounts,
          duplicateCount: data.duplicateCount,
          skippedCount: data.skippedCount,
        });
      } else if (data.type === 'error') {
        setIsImporting(false);
        setImportError(data.error || 'Failed to import dictionary');
      } else if (data.type === 'cancelled') {
        setIsImporting(false);
        setImportStatusMessage('Import cancelled by user.');
      }
    };

    worker.onerror = (err) => {
      console.error('Worker error:', err);
      setIsImporting(false);
      setImportError(err.message || 'Worker thread failed');
    };

    worker.postMessage({
      type: 'start',
      languageCode: activeLanguageId,
      explicitKind: selectedKind,
      ...startPayload,
    });
  };

  const handleCancelImport = () => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'cancel' });
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setIsImporting(false);
    setImportStatusMessage('Import cancelled.');
  };

  const readKanjiFileAsText = async (file: File): Promise<string> => {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.zip')) {
      const buf = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      const entry = Object.values(zip.files).find(
        (f) => !f.dir && /\.(csv|tsv|json|txt)$/i.test(f.name)
      );
      if (!entry) {
        throw new Error(`No .csv, .tsv, or .json file found inside "${file.name}"`);
      }
      return await entry.async('text');
    }
    if (lower.endsWith('.gz') && typeof DecompressionStream !== 'undefined') {
      const buf = await file.arrayBuffer();
      const stream = new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')));
      return await stream.text();
    }
    return await file.text();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    setImportError(null);

    if (selectedKind === 'kanji-levels') {
      try {
        const previews: Array<{
          fileName: string;
          text: string;
          size: number;
          parsed: ParsedKanjiTable;
          mapping: KanjiColumnMapping;
        }> = [];

        for (let i = 0; i < fileList.length; i++) {
          const f = fileList[i];
          const text = await readKanjiFileAsText(f);
          const parsed = parseKanjiListTable(text, f.name);
          if (parsed.rows.length === 0) {
            throw new Error(`No rows found in "${f.name}". Check that it is valid CSV, TSV, or JSON.`);
          }
          previews.push({
            fileName: f.name,
            text,
            size: f.size,
            parsed,
            mapping: { ...parsed.detectedMapping },
          });
        }

        setKanjiPreviewFiles(previews);
        setActivePreviewIndex(0);
      } catch (err: any) {
        setImportError(err?.message || 'Failed to parse kanji file for preview');
      } finally {
        e.target.value = '';
      }
      return;
    }

    const file = fileList[0];
    const buffer = await file.arrayBuffer();
    e.target.value = '';
    startImportWorker({
      source: 'file',
      fileData: buffer,
      fileName: file.name,
      explicitKind: selectedKind,
    });
  };

  const handleConfirmKanjiPreviewImport = () => {
    if (kanjiPreviewFiles.length === 0) return;
    setImportError(null);
    const filesPayload = kanjiPreviewFiles.map((item) => ({
      fileName: item.fileName,
      text: item.text,
      size: item.size,
      columnMapping: item.mapping,
    }));

    startImportWorker({
      source: 'files',
      files: filesPayload,
      fileName:
        filesPayload.length === 1
          ? filesPayload[0].fileName
          : `${filesPayload.length} kanji files`,
      explicitKind: 'kanji-levels',
    });
  };

  const updatePreviewMapping = (field: keyof KanjiColumnMapping, value: number) => {
    setKanjiPreviewFiles((prev) =>
      prev.map((item, idx) =>
        idx === activePreviewIndex
          ? { ...item, mapping: { ...item.mapping, [field]: value } }
          : item
      )
    );
  };

  const handleUrlImport = () => {
    if (!urlInput.trim()) return;
    setImportError(null);
    startImportWorker({
      source: 'url',
      url: urlInput.trim(),
    });
  };

  const handleSampleImport = (url: string, name: string, kind: ImportKind) => {
    setImportError(null);
    setSelectedKind(kind);
    startImportWorker({
      source: 'url',
      url,
      fileName: name,
      explicitKind: kind,
    });
  };

  const handleConfirmReplace = () => {
    if (!duplicatePrompt) return;
    const payload = duplicatePrompt.pendingPayload;
    const existingId = duplicatePrompt.existingImport.importId;
    setDuplicatePrompt(null);

    startImportWorker({
      ...payload,
      forceReplace: true,
      existingImportId: existingId,
    });
  };

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text)] flex flex-col pb-24 md:pb-12">
      {/* Header */}
      <header className="bg-[var(--surface)] border-b border-[var(--border)] px-4 py-6">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Package className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
              <h1 className="text-2xl font-black tracking-tight">Language Packs</h1>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Multi-pack coexistence, names dictionaries, kanji data, and isolated linguistic storage
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-semibold border border-emerald-200 dark:border-emerald-800 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              Multi-Pack Storage Active
            </span>
          </div>
        </div>
      </header>

      {/* Main pack list */}
      <main className="max-w-5xl w-full mx-auto p-4 sm:p-6 space-y-6 flex-1">
        {allPacks.map((pack) => {
          const isActive = pack.id === activeLanguageId;
          const isJapanese = pack.id === 'ja';

          // All imports for this language (Requirement 7 & 8)
          const packImports = importsList.filter((item) => item.languageCode === pack.id);
          const totalEntries = packImports.reduce((acc, item) => acc + item.entryCount, 0);
          const hasInstalledPacks = packImports.length > 0;

          return (
            <div
              key={pack.id}
              className={`rounded-3xl border transition-all duration-200 overflow-hidden ${
                isActive
                  ? 'border-indigo-500 bg-[var(--surface)] shadow-md ring-2 ring-indigo-500/20'
                  : 'border-[var(--border)] bg-[var(--surface)]'
              }`}
            >
              {/* Pack Title Bar */}
              <div className="p-6 border-b border-[var(--border)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="text-2xl">{pack.flagEmoji}</span>
                    <h2 className="text-xl font-bold text-[var(--text)]">
                      {pack.name} ({pack.nativeName})
                    </h2>
                    {isActive ? (
                      <span className="text-xs px-2.5 py-0.5 rounded-full font-bold bg-indigo-600 text-white shadow-sm">
                        Active Language
                      </span>
                    ) : (
                      <button
                        onClick={() => setActiveLanguage(pack.id)}
                        className="text-xs px-3 py-1 rounded-full font-semibold border border-indigo-600 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-slate-800 transition"
                      >
                        Set as Active
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 max-w-2xl leading-relaxed">
                    {pack.description}
                  </p>
                </div>

                {/* Level System Badge */}
                <div className="flex items-center gap-2 self-start sm:self-center">
                  <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-xs flex items-center gap-2">
                    <Award className="w-4 h-4 text-amber-500" />
                    <div>
                      <span className="font-bold text-slate-700 dark:text-slate-300 block">
                        System: {pack.levelSystem.name}
                      </span>
                      <div className="flex items-center gap-1 mt-0.5">
                        {pack.levelSystem.levels.map((lvl) => (
                          <span
                            key={lvl.code}
                            className="text-[10px] px-1 py-0.2 rounded font-bold bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300"
                          >
                            {lvl.code}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Japanese JMdict & Multi-Pack Status Card */}
              {isJapanese && (
                <div className="p-6 bg-gradient-to-r from-indigo-50/60 to-purple-50/60 dark:from-slate-800/50 dark:to-indigo-950/30 border-b border-slate-200 dark:border-slate-800 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Database className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                        <h3 className="font-bold text-base text-slate-900 dark:text-white">
                          Dictionary & Linguistic Database
                        </h3>
                        {hasInstalledPacks ? (
                          <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800 flex items-center gap-1">
                            <Check className="w-3 h-3" />
                            {packImports.length} Pack{packImports.length > 1 ? 's' : ''} Coexisting
                          </span>
                        ) : (
                          <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-300 dark:border-amber-800">
                            Using Built-in sample fallback
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xl leading-relaxed">
                        Supports concurrent JMdict vocabulary, JMnedict names, kanji dictionaries, Tatoeba sentences, and JLPT overlays without overwriting.
                      </p>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => {
                          setSelectedKind('dictionary');
                          setShowImportModal(true);
                        }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm transition active:scale-95"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Import Pack
                      </button>
                      <button
                        onClick={() => {
                          setSelectedKind('jlpt');
                          setShowImportModal(true);
                        }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/40 text-xs font-bold transition active:scale-95"
                      >
                        <Award className="w-3.5 h-3.5" />
                        Import JLPT List
                      </button>
                      <button
                        onClick={() => {
                          setSelectedKind('frequency');
                          setShowImportModal(true);
                        }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-teal-300 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-900/40 text-xs font-bold transition active:scale-95"
                      >
                        <BarChart3 className="w-3.5 h-3.5" />
                        Import Frequency
                      </button>
                    </div>
                  </div>

                  {/* Honest Status Metrics derived from IndexedDB */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div className="p-3 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
                      <span className="text-[10px] font-semibold text-[var(--text-muted)] block uppercase tracking-wider">
                        Total Installed Entries
                      </span>
                      <span className="text-sm sm:text-base font-bold font-mono text-[var(--text)]">
                        {isLoadingMeta
                          ? '...'
                          : hasInstalledPacks
                          ? totalEntries.toLocaleString()
                          : `${JAPANESE_DICTIONARY_SAMPLE.length} (sample fallback)`}
                      </span>
                    </div>

                    <div className="p-3 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
                      <span className="text-[10px] font-semibold text-[var(--text-muted)] block uppercase tracking-wider">
                        Active Packs
                      </span>
                      <span className="text-sm sm:text-base font-bold font-mono text-[var(--text)]">
                        {isLoadingMeta ? '...' : `${packImports.length} pack${packImports.length === 1 ? '' : 's'}`}
                      </span>
                    </div>

                    <div className="p-3 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
                      <span className="text-[10px] font-semibold text-[var(--text-muted)] block uppercase tracking-wider">
                        Indexed DB Rows
                      </span>
                      <span className="text-sm sm:text-base font-bold font-mono text-[var(--text)] truncate block">
                        {isLoadingMeta ? '...' : actualJmdictCount.toLocaleString()}
                      </span>
                    </div>

                    <div className="p-3 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
                      <span className="text-[10px] font-semibold text-[var(--text-muted)] block uppercase tracking-wider">
                        Status
                      </span>
                      <span
                        className={`text-xs font-bold block mt-0.5 ${
                          hasInstalledPacks
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-amber-600 dark:text-amber-400'
                        }`}
                      >
                        {hasInstalledPacks ? 'Multi-pack Indexed' : 'Sample fallback only'}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Built-in Sample Dictionary Card */}
              {isJapanese && (
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-900/30">
                  <div className="p-4 rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <BookOpen className="w-4 h-4 text-indigo-500" />
                        <h4 className="font-bold text-sm text-slate-900 dark:text-white">
                          Built-in Sample Dictionary
                        </h4>
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                          Built-in sample (development only)
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Contains {JAPANESE_DICTIONARY_SAMPLE.length} core vocabulary words (日本, 勉強, 食べる, 行く, 見る...) with furigana and example sentences. Used as an automatic fallback when no full dictionary is installed.
                      </p>
                      <div className="flex items-center gap-3 pt-1 text-[11px] text-slate-400">
                        <span>Entries: {JAPANESE_DICTIONARY_SAMPLE.length}</span>
                        <span>•</span>
                        <span>Size: ~12 KB</span>
                        <span>•</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                          Always Available
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 text-xs text-slate-400 bg-slate-50 dark:bg-slate-800/60 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 self-start sm:self-center shrink-0">
                      <Lock className="w-3.5 h-3.5 text-slate-400" />
                      <span>Permanent built-in fallback</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Kanji Data Status Row & Live Inspection Box (Requirement 2) */}
              {isJapanese && (
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 bg-amber-50/20 dark:bg-amber-950/10 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Sparkles className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                        <h3 className="font-bold text-base text-slate-900 dark:text-white">
                          Kanji Data Status
                        </h3>
                        <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-300 dark:border-amber-800">
                          {storedKanjiCount.toLocaleString()} kanji stored on device
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xl">
                        Characters stored with JLPT levels, stroke counts, on/kun readings, and meanings from imported kanji lists.
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setSelectedKind('kanji-levels');
                          setShowImportModal(true);
                        }}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-sm transition active:scale-95"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Import Kanji List
                      </button>
                    </div>
                  </div>

                  {/* Level breakdown pills */}
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                      Levels on device:
                    </span>
                    {(['N5', 'N4', 'N3', 'N2', 'N1'] as const).map((lvl) => (
                      <span
                        key={lvl}
                        className="text-[11px] px-2.5 py-1 rounded-lg font-bold border bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 shadow-xs flex items-center gap-1.5"
                      >
                        <span className="font-mono text-amber-600 dark:text-amber-400">{lvl}:</span>
                        <span>{kanjiLevelsBreakdown[lvl].toLocaleString()}</span>
                      </span>
                    ))}
                    {kanjiLevelsBreakdown.unlisted > 0 && (
                      <span className="text-[11px] px-2.5 py-1 rounded-lg font-medium bg-slate-100 dark:bg-slate-800 text-slate-500 border border-slate-200 dark:border-slate-700">
                        Unlisted: {kanjiLevelsBreakdown.unlisted.toLocaleString()}
                      </span>
                    )}
                  </div>

                  {/* "Look up a kanji" test box */}
                  <div className="p-4 rounded-2xl border border-amber-200/80 dark:border-amber-900/50 bg-white dark:bg-slate-900 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <h4 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white flex items-center gap-1.5">
                          <span>Look up a kanji</span>
                          <span className="text-[10px] font-normal text-slate-400">(Device inspection test box)</span>
                        </h4>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                          Type one character (e.g. 店, 員, 学, 食) to verify exactly what is stored in this device's IndexedDB.
                        </p>
                      </div>
                      <div className="relative w-full sm:w-48">
                        <input
                          type="text"
                          maxLength={4}
                          value={kanjiSearchChar}
                          onChange={(e) => setKanjiSearchChar(e.target.value)}
                          placeholder="Type 1 kanji..."
                          className="w-full px-3 py-2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-amber-500 font-bold text-center text-lg shadow-inner"
                        />
                      </div>
                    </div>

                    {/* Result Inspection Card */}
                    {isSearchingKanji && (
                      <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
                        <span>Querying IndexedDB kanjiEntries...</span>
                      </div>
                    )}

                    {!isSearchingKanji && kanjiSearchResult === null && kanjiSearchChar.trim() && (
                      <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 flex items-center justify-between gap-2">
                        <span>
                          Character <strong>"{Array.from(kanjiSearchChar.trim())[0]}"</strong> is <strong>not stored</strong> in this device's IndexedDB.
                        </span>
                        <span className="text-[11px] text-slate-400">Import a kanji list to install it.</span>
                      </div>
                    )}

                    {!isSearchingKanji && kanjiSearchResult && (
                      <div className="p-3.5 rounded-xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-300/70 dark:border-amber-800/70 space-y-2.5">
                        <div className="flex items-start justify-between gap-3 flex-wrap">
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-xl bg-white dark:bg-slate-800 border border-amber-200 dark:border-amber-800 flex items-center justify-center text-2xl font-bold text-amber-700 dark:text-amber-300 shadow-xs">
                              {kanjiSearchResult.character}
                            </div>
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-bold text-sm text-slate-900 dark:text-white">
                                  {kanjiSearchResult.character}
                                </span>
                                <span
                                  className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${
                                    kanjiSearchResult.jlptLevel === 'N5'
                                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                                      : kanjiSearchResult.jlptLevel === 'N4'
                                      ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300 border-sky-300 dark:border-sky-800'
                                      : kanjiSearchResult.jlptLevel === 'N3'
                                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-300 dark:border-amber-800'
                                      : kanjiSearchResult.jlptLevel === 'N2'
                                      ? 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300 border-orange-300 dark:border-orange-800'
                                      : kanjiSearchResult.jlptLevel === 'N1'
                                      ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border-rose-300 dark:border-rose-800'
                                      : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-300'
                                  }`}
                                >
                                  JLPT: {kanjiSearchResult.jlptLevel || 'No level'}
                                </span>
                                {kanjiSearchResult.strokeCount && (
                                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-mono">
                                    {kanjiSearchResult.strokeCount} strokes
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-slate-700 dark:text-slate-300 mt-1 font-medium">
                                Meanings: {kanjiSearchResult.meanings?.join(', ') || '(none)'}
                              </p>
                            </div>
                          </div>

                          <div className="text-[10px] text-slate-400 font-mono text-right">
                            <span>Imports: {kanjiSearchResult.importIds?.join(', ') || 'unknown'}</span>
                          </div>
                        </div>

                        {/* Readings */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-amber-200/50 dark:border-amber-900/40 text-xs">
                          <div>
                            <span className="font-semibold text-slate-500 dark:text-slate-400">On-yomi (音):</span>{' '}
                            <span className="font-bold text-slate-800 dark:text-slate-200">
                              {kanjiSearchResult.readings?.on?.join(', ') || '(none)'}
                            </span>
                          </div>
                          <div>
                            <span className="font-semibold text-slate-500 dark:text-slate-400">Kun-yomi (訓):</span>{' '}
                            <span className="font-bold text-slate-800 dark:text-slate-200">
                              {kanjiSearchResult.readings?.kun?.join(', ') || '(none)'}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Imported Data List Section (Requirement 7: shows total at top, each with its own Delete) */}
              <div className="p-6 border-b border-slate-100 dark:border-slate-800 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <Layers className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                      Imported data
                    </h3>
                    {/* Total at the top (Requirement 7: e.g. "3 imports, 245,310 entries") */}
                    <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                      {packImports.length} import{packImports.length === 1 ? '' : 's'},{' '}
                      {totalEntries.toLocaleString()} entries
                    </span>
                  </div>

                  <div className="flex items-center gap-3 self-start sm:self-auto flex-wrap">
                    {isJapanese && (
                      <button
                        onClick={() => {
                          setSelectedKind('kanji-levels');
                          setShowImportModal(true);
                        }}
                        className="text-xs font-bold text-amber-600 dark:text-amber-400 hover:underline flex items-center gap-1"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        Import kanji list
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setSelectedKind('dictionary');
                        setShowImportModal(true);
                      }}
                      className="text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Import new file
                    </button>
                  </div>
                </div>

                {packImports.length === 0 ? (
                  <div className="p-6 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800 text-center space-y-2">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      No external datasets imported yet for {pack.name}. You can import multiple packs at once (JMdict common, full JMdict, names, kanji, sentences, JLPT lists).
                    </p>
                    <button
                      onClick={() => {
                        setSelectedKind('dictionary');
                        setShowImportModal(true);
                      }}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 text-xs font-bold transition"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Import first pack
                    </button>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                    {packImports.map((item) => {
                      const formattedSize =
                        item.fileSize > 1024 * 1024
                          ? `${(item.fileSize / (1024 * 1024)).toFixed(1)} MB`
                          : `${Math.round(item.fileSize / 1024)} KB`;

                      const formattedDate = new Date(item.date).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      });

                      return (
                        <div
                          key={item.importId}
                          className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-slate-50/50 dark:hover:bg-slate-800/40 transition"
                        >
                          <div className="space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <FileText className="w-4 h-4 text-indigo-500" />
                              <span className="font-bold text-sm text-slate-900 dark:text-white font-mono">
                                {item.fileName}
                              </span>
                              <span
                                className={`text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider ${
                                  item.kind === 'dictionary'
                                    ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300'
                                    : item.kind === 'names'
                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                                    : item.kind === 'kanji'
                                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                                    : item.kind === 'sentences'
                                    ? 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300'
                                    : item.kind === 'jlpt'
                                    ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300'
                                    : 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300'
                                }`}
                              >
                                {item.kind}
                              </span>

                              {item.hasNonEnglishGlosses && (
                                <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800 flex items-center gap-1">
                                  <AlertCircle className="w-3 h-3 text-amber-500" />
                                  Non-English glosses filtered
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
                              <span>Entries: <strong>{item.entryCount.toLocaleString()}</strong></span>
                              <span>•</span>
                              <span>Size: <strong>{formattedSize}</strong></span>
                              <span>•</span>
                              <span>Imported: {formattedDate}</span>
                              {item.fingerprint && (
                                <span title={`SHA-256 Fingerprint: ${item.fingerprint}`}>
                                  • FP: <code className="font-mono">{item.fingerprint.slice(0, 8)}...</code>
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 self-end md:self-center">
                            {item.hasNonEnglishGlosses && (
                              <button
                                onClick={() => handleReindex(pack.id)}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 text-xs font-semibold transition"
                                title="Re-index to verify English glosses only"
                              >
                                <RefreshCw className="w-3 h-3" />
                                Re-index
                              </button>
                            )}

                            {/* Individual Delete button with confirmation (Requirement 4 & 7) */}
                            <button
                              onClick={() => openDeleteImportModal(item)}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-rose-200 dark:border-rose-900/60 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-xs font-semibold transition"
                              title="Delete this pack"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              Delete
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Downloadable Assets */}
              <div className="p-6 space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <HardDrive className="w-4 h-4" />
                  Language Pack Assets & Models ({pack.assetsManifest.length})
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {pack.assetsManifest.map((asset) => {
                    const key = `${pack.id}:${asset.id}`;

                    let isInstalled = false;
                    let displaySize = '—';
                    let displayVersion = '—';

                    if (asset.id === 'jmdict-core') {
                      isInstalled = packImports.some((i) => i.kind === 'dictionary');
                      if (isInstalled) {
                        displaySize = dictMeta?.sizeBytes
                          ? `${(dictMeta.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                          : 'Indexed';
                        displayVersion = dictMeta?.version || 'imported';
                      }
                    } else if (asset.id === 'kuromoji-dict') {
                      isInstalled = kuromojiCache.isInstalled;
                      if (isInstalled) {
                        displaySize = `${(kuromojiCache.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
                        displayVersion = `${kuromojiCache.fileCount} cached files`;
                      }
                    } else {
                      const downloaded = downloadedAssets[key];
                      isInstalled = !!downloaded;
                      if (downloaded) {
                        displaySize = `${(downloaded.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
                        displayVersion = downloaded.version;
                      }
                    }

                    const inProgress = isDownloading[key] || (asset.id === 'kuromoji-dict' && isInstallingKuromoji);
                    const progress = asset.id === 'kuromoji-dict' ? kuromojiProgress : (downloadProgress[key] || 0);

                    return (
                      <div
                        key={asset.id}
                        className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/40 flex flex-col justify-between space-y-3"
                      >
                        <div className="space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <h4 className="font-bold text-sm text-slate-900 dark:text-white">
                              {asset.name}
                            </h4>
                            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 font-semibold shrink-0">
                              {isInstalled ? displaySize : 'Not installed'}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
                            {asset.description}
                          </p>
                          <div className="text-[11px] text-slate-400 flex items-center gap-2 pt-1">
                            {isInstalled ? (
                              <span>v{displayVersion}</span>
                            ) : (
                              <span>Online remote resource</span>
                            )}
                          </div>
                        </div>

                        {/* Progress */}
                        {inProgress && (
                          <div className="space-y-1">
                            <div className="flex justify-between text-[11px] font-semibold text-indigo-600 dark:text-indigo-400">
                              <span>Downloading & caching...</span>
                              <span>{progress}%</span>
                            </div>
                            <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                              <div
                                style={{ width: `${progress}%` }}
                                className="h-full bg-indigo-600 transition-all duration-150"
                              />
                            </div>
                          </div>
                        )}

                        <div className="flex items-center justify-between pt-1">
                          {isInstalled ? (
                            <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                              <Check className="w-4 h-4" />
                              Installed
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400 font-medium">
                              Not installed
                            </span>
                          )}

                          <div className="flex items-center gap-1.5">
                            {!isInstalled ? (
                              asset.id === 'jmdict-core' ? (
                                <button
                                  onClick={() => {
                                    setSelectedKind('dictionary');
                                    setShowImportModal(true);
                                  }}
                                  className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition shadow-sm"
                                >
                                  <Upload className="w-3.5 h-3.5" />
                                  Import
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleDownloadAsset(pack.id, asset)}
                                  disabled={inProgress}
                                  className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold transition shadow-sm"
                                >
                                  <DownloadCloud className="w-3.5 h-3.5" />
                                  Install
                                </button>
                              )
                            ) : asset.id === 'kuromoji-dict' ? (
                              <button
                                onClick={() => handleDeleteGenericAsset(pack.id, asset.id)}
                                className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-slate-800 transition"
                                title="Remove offline cached asset"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}

        {/* Storage Section (Requirement 4) */}
        <section className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <HardDrive className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                  Storage & Data Management
                </h2>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                navigator.storage.estimate breakdown with isolated controls for language assets vs. personal study data
              </p>
            </div>

            {storageEstimate && (
              <div className="text-right">
                <span className="text-sm font-bold font-mono text-slate-900 dark:text-white block">
                  {(storageEstimate.usage / (1024 * 1024)).toFixed(1)} MB used
                </span>
                <span className="text-[11px] text-slate-400">
                  of {(storageEstimate.quota / (1024 * 1024 * 1024)).toFixed(1)} GB quota
                </span>
              </div>
            )}
          </div>

          {/* Storage Bar */}
          {storageEstimate && (
            <div className="space-y-1.5">
              <div className="w-full h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                <div
                  style={{
                    width: `${Math.min(
                      100,
                      Math.max(1, (storageEstimate.usage / storageEstimate.quota) * 100)
                    )}%`,
                  }}
                  className="h-full bg-gradient-to-r from-indigo-500 to-emerald-500 rounded-full"
                />
              </div>
            </div>
          )}

          {/* Granular Breakdown Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800">
              <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">
                Total Installed Packs
              </span>
              <span className="text-base font-bold font-mono text-slate-900 dark:text-white mt-1 block">
                {importsList.length} packs
              </span>
              <span className="text-[10px] text-slate-400">Multi-pack coexisting</span>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800">
              <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">
                Kuromoji Cache
              </span>
              <span className="text-base font-bold font-mono text-slate-900 dark:text-white mt-1 block">
                {kuromojiCache.isInstalled ? `${kuromojiCache.fileCount} files` : 'Not cached'}
              </span>
              <span className="text-[10px] text-slate-400">CacheStorage</span>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800">
              <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">
                Personal Cards
              </span>
              <span className="text-base font-bold font-mono text-slate-900 dark:text-white mt-1 block">
                {studyStats.cards.toLocaleString()}
              </span>
              <span className="text-[10px] text-slate-400">Study Database</span>
            </div>

            <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800">
              <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">
                Reading History
              </span>
              <span className="text-base font-bold font-mono text-slate-900 dark:text-white mt-1 block">
                {studyStats.lookups.toLocaleString()}
              </span>
              <span className="text-[10px] text-slate-400">Word Lookups</span>
            </div>
          </div>

          {/* Two Separated Clear Actions */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex flex-col justify-between space-y-3">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 font-bold text-sm text-slate-900 dark:text-white">
                  <ShieldCheck className="w-4 h-4 text-indigo-500" />
                  <h4>Language Data Management</h4>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Removes all imported dictionaries, tokenizers, and language pack caches. Reverts to built-in sample dictionaries.
                </p>
                <p className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 pt-1">
                  ✓ Leaves your flashcards, reading history, saved texts, and settings untouched.
                </p>
              </div>

              <button
                onClick={openClearAllLanguageModal}
                className="w-full py-2 px-3 rounded-xl border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 text-xs font-bold transition flex items-center justify-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear all language data
              </button>
            </div>

            <div className="p-4 rounded-2xl border border-rose-200 dark:border-rose-900/60 bg-rose-50/30 dark:bg-rose-950/20 flex flex-col justify-between space-y-3">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 font-bold text-sm text-rose-700 dark:text-rose-300">
                  <AlertTriangle className="w-4 h-4 text-rose-500" />
                  <h4>Personal Study Data</h4>
                </div>
                <p className="text-xs text-rose-600/80 dark:text-rose-400/80 leading-relaxed">
                  Permanently erases your personal flashcards, reading history, and saved documents. Dictionaries and language pack assets remain untouched.
                </p>
                <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 pt-1">
                  • Language dictionaries and tokenizer files are strictly preserved.
                </p>
              </div>

              <button
                onClick={openDeleteStudyDataModal}
                className="w-full py-2 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-sm transition flex items-center justify-center gap-1.5 active:scale-95"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete my study data
              </button>
            </div>
          </div>
        </section>

        {/* Credits & Dataset Licenses */}
        <section className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-3">
          <div className="flex items-center gap-2">
            <Info className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Data Sources, Attribution & Licenses
            </h3>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 space-y-2 leading-relaxed">
            <p>
              • <strong>Kanji JLPT Datasets & Lists</strong>: Community-curated JLPT distributions (N5 beginner to N1 advanced). Note that the Japan Foundation and Japan Educational Exchanges and Services do not publish official fixed kanji lists.
            </p>
            <p>
              • <strong>KANJIDIC2 & JMdict</strong>: Property of the Electronic Dictionary Research and Development Group (EDRDG), used in conformance with the Group's licence (Creative Commons Attribution-ShareAlike 3.0 Unported — CC BY-SA 3.0).
            </p>
            <p>
              • <strong>JMnedict</strong>: Japanese Names Dictionary, maintained by EDRDG.
            </p>
            <p>
              • <strong>Tatoeba</strong>: Example sentences licensed under CC BY 2.0 FR by community contributors.
            </p>
          </div>
        </section>
      </main>

      {/* Duplicate Fingerprint / Replace Confirmation Modal (Requirement 2) */}
      {duplicatePrompt?.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md bg-[var(--surface)] border border-[var(--border)] rounded-3xl shadow-2xl overflow-hidden p-6 space-y-4">
            <div className="flex items-center gap-2.5 text-amber-600 dark:text-amber-400">
              <Info className="w-6 h-6 shrink-0" />
              <h3 className="text-base font-bold text-[var(--text)]">
                File Already Installed
              </h3>
            </div>

            <div className="space-y-2 text-xs">
              <p className="font-semibold text-[var(--text-secondary)]">
                This file is already installed. Replace it?
              </p>
              <div className="p-3 rounded-xl bg-[var(--surface-muted)] border border-[var(--border)] space-y-1">
                <div>
                  File: <strong className="font-mono">{duplicatePrompt.existingImport.fileName}</strong>
                </div>
                <div>
                  Kind: <span className="uppercase font-bold">{duplicatePrompt.existingImport.kind}</span>
                </div>
                <div>
                  Entries: {duplicatePrompt.existingImport.entryCount.toLocaleString()}
                </div>
                <div>
                  Installed on:{' '}
                  {new Date(duplicatePrompt.existingImport.date).toLocaleDateString()}
                </div>
              </div>
              <p className="text-[var(--text-muted)]">
                Replacing will update its entries with the newly uploaded content. All other installed packs will remain untouched.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border)]">
              <button
                onClick={() => setDuplicatePrompt(null)}
                className="px-4 py-2 text-xs font-semibold rounded-xl text-[var(--text-muted)] hover:bg-[var(--surface-muted)] transition"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmReplace}
                className="px-4 py-2 text-xs font-bold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition active:scale-95"
              >
                Replace Existing
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation & Batch Deletion Modal */}
      {deleteModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md bg-[var(--surface)] border border-[var(--border)] rounded-3xl shadow-2xl overflow-hidden p-6 space-y-4">
            <div className="flex items-center gap-2.5 text-rose-600 dark:text-rose-400">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h3 className="text-base font-bold text-[var(--text)]">
                {deleteModal.title}
              </h3>
            </div>

            <div className="space-y-2 text-xs">
              <p className="font-semibold text-[var(--text-secondary)]">
                {deleteModal.message}
              </p>
              {deleteModal.submessage && (
                <p className="text-[var(--text-muted)] leading-relaxed">
                  {deleteModal.submessage}
                </p>
              )}
            </div>

            {/* Progress bar during deletion */}
            {deleteModal.inProgress && (
              <div className="py-2 space-y-2">
                <div className="flex justify-between text-xs font-semibold text-[var(--text-secondary)]">
                  <span className="truncate">{deleteModal.progressText}</span>
                  <span className="font-mono text-indigo-600 dark:text-indigo-400">
                    {deleteModal.progressPct}%
                  </span>
                </div>
                <div className="w-full h-2.5 bg-[var(--surface-muted)] rounded-full overflow-hidden">
                  <div
                    style={{ width: `${deleteModal.progressPct}%` }}
                    className="h-full bg-rose-600 transition-all duration-150"
                  />
                </div>
              </div>
            )}

            {!deleteModal.inProgress && (
              <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border)]">
                <button
                  onClick={() => setDeleteModal((prev) => ({ ...prev, isOpen: false }))}
                  className="px-4 py-2 text-xs font-semibold rounded-xl text-[var(--text-muted)] hover:bg-[var(--surface-muted)] transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmDelete}
                  className="px-4 py-2 text-xs font-bold rounded-xl bg-rose-600 hover:bg-rose-700 text-white shadow-sm transition active:scale-95"
                >
                  Confirm & Delete
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Re-indexing Progress Modal */}
      {reindexState.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md bg-[var(--surface)] border border-[var(--border)] rounded-3xl shadow-2xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <RefreshCw className={`w-5 h-5 text-indigo-600 ${reindexState.inProgress ? 'animate-spin' : ''}`} />
              <h3 className="font-bold text-base text-[var(--text)]">
                Re-indexing Senses
              </h3>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-xs font-semibold text-[var(--text-secondary)]">
                <span>{reindexState.statusText}</span>
                <span className="font-mono text-indigo-600">{reindexState.progressPct}%</span>
              </div>
              <div className="w-full h-2.5 bg-[var(--surface-muted)] rounded-full overflow-hidden">
                <div
                  style={{ width: `${reindexState.progressPct}%` }}
                  className="h-full bg-indigo-600 transition-all duration-150"
                />
              </div>
              {reindexState.result && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium pt-1">
                  {reindexState.result}
                </p>
              )}
            </div>

            {!reindexState.inProgress && (
              <div className="flex justify-end pt-2 border-t border-[var(--border)]">
                <button
                  onClick={() => setReindexState((prev) => ({ ...prev, isOpen: false }))}
                  className="px-4 py-2 text-xs font-bold rounded-xl bg-indigo-600 text-white hover:bg-indigo-700"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* JMdict Dictionary & Multi-Pack Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div
            className={`w-full ${
              kanjiPreviewFiles.length > 0 && selectedKind === 'kanji-levels' && importTab === 'upload' && !isImporting
                ? 'max-w-3xl'
                : 'max-w-xl'
            } max-h-[90vh] overflow-y-auto bg-[var(--surface)] border border-[var(--border)] rounded-3xl shadow-2xl p-6 space-y-4`}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
              <div className="flex items-center gap-2">
                <Database className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <h3 className="font-bold text-base text-[var(--text)]">
                  Import Pack or Dataset
                </h3>
              </div>
              <button
                onClick={() => {
                  if (isImporting) handleCancelImport();
                  setShowImportModal(false);
                  setKanjiPreviewFiles([]);
                  setActivePreviewIndex(0);
                }}
                className="p-1.5 rounded-xl text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-muted)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Pack Kind selector */}
            {!isImporting && (
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
                  Pack Kind:
                </label>
                <div className="flex flex-wrap gap-1.5 text-xs font-semibold">
                  {(['dictionary', 'names', 'kanji-levels', 'sentences', 'jlpt', 'frequency'] as ImportKind[]).map(
                    (k) => (
                      <button
                        key={k}
                        onClick={() => {
                          setSelectedKind(k);
                          setKanjiPreviewFiles([]);
                          setActivePreviewIndex(0);
                          setImportError(null);
                        }}
                        className={`px-3 py-1 rounded-xl transition ${
                          selectedKind === k
                            ? 'bg-indigo-600 text-white shadow-xs'
                            : 'bg-[var(--surface-muted)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
                        }`}
                      >
                        {k === 'kanji-levels' ? 'KANJI LEVELS' : k.toUpperCase()}
                      </button>
                    )
                  )}
                </div>
              </div>
            )}

            {/* Source tabs */}
            {!isImporting && (
              <div className="flex rounded-xl bg-[var(--surface-muted)] p-1 text-xs font-semibold border border-[var(--border)]">
                <button
                  onClick={() => setImportTab('upload')}
                  className={`flex-1 py-1.5 rounded-lg transition ${
                    importTab === 'upload'
                      ? 'bg-[var(--surface)] text-[var(--accent-text)] shadow-xs'
                      : 'text-[var(--text-muted)]'
                  }`}
                >
                  Upload File
                </button>
                <button
                  onClick={() => {
                    setImportTab('url');
                    setKanjiPreviewFiles([]);
                  }}
                  className={`flex-1 py-1.5 rounded-lg transition ${
                    importTab === 'url'
                      ? 'bg-[var(--surface)] text-[var(--accent-text)] shadow-xs'
                      : 'text-[var(--text-muted)]'
                  }`}
                >
                  Download URL
                </button>
                <button
                  onClick={() => {
                    setImportTab('sample');
                    setKanjiPreviewFiles([]);
                  }}
                  className={`flex-1 py-1.5 rounded-lg transition ${
                    importTab === 'sample'
                      ? 'bg-[var(--surface)] text-[var(--accent-text)] shadow-xs'
                      : 'text-[var(--text-muted)]'
                  }`}
                >
                  Bundled Samples
                </button>
              </div>
            )}

            {/* Tab 1: File Upload */}
            {!isImporting && importTab === 'upload' && (
              <div className="space-y-4 py-2">
                {selectedKind === 'kanji-levels' && kanjiPreviewFiles.length > 0 ? (
                  (() => {
                    const activeItem = kanjiPreviewFiles[activePreviewIndex] || kanjiPreviewFiles[0];
                    const previewRows = buildKanjiPreviewRows(activeItem.parsed, activeItem.mapping, 5);
                    const totalRowsAllFiles = kanjiPreviewFiles.reduce(
                      (sum, item) => sum + item.parsed.rows.length,
                      0
                    );
                    const formatLabelMap: Record<string, string> = {
                      csv: 'CSV',
                      tsv: 'TSV',
                      'json-map': 'JSON (character → level)',
                      'json-array': 'JSON (array)',
                    };

                    const mappingFields: Array<{
                      key: keyof KanjiColumnMapping;
                      label: string;
                      required?: boolean;
                    }> = [
                      { key: 'charCol', label: 'Kanji Character', required: true },
                      { key: 'levelCol', label: 'JLPT Level' },
                      { key: 'readingCol', label: 'Readings (auto)' },
                      { key: 'onCol', label: 'On-yomi' },
                      { key: 'kunCol', label: 'Kun-yomi' },
                      { key: 'meaningCol', label: 'Meanings' },
                      { key: 'strokeCol', label: 'Strokes' },
                    ];

                    return (
                      <div className="space-y-4">
                        {/* File tabs when multiple files selected */}
                        {kanjiPreviewFiles.length > 1 && (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {kanjiPreviewFiles.map((f, idx) => (
                              <button
                                key={`${f.fileName}-${idx}`}
                                onClick={() => setActivePreviewIndex(idx)}
                                className={`px-2.5 py-1 rounded-lg text-xs font-mono font-semibold border transition ${
                                  idx === activePreviewIndex
                                    ? 'bg-amber-600 text-white border-amber-600'
                                    : 'bg-[var(--surface-muted)] text-[var(--text-secondary)] border-[var(--border)] hover:border-amber-400'
                                }`}
                              >
                                {f.fileName} ({f.parsed.rows.length})
                              </button>
                            ))}
                          </div>
                        )}

                        {/* File metadata & inferred level banner */}
                        <div className="p-3 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)] flex flex-wrap items-center justify-between gap-2 text-xs">
                          <div className="flex items-center gap-2 flex-wrap">
                            <FileText className="w-4 h-4 text-amber-500" />
                            <span className="font-mono font-bold text-[var(--text)]">
                              {activeItem.fileName}
                            </span>
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300">
                              {formatLabelMap[activeItem.parsed.format] || activeItem.parsed.format}
                            </span>
                            <span className="text-[var(--text-muted)]">
                              {activeItem.parsed.rows.length.toLocaleString()} rows
                            </span>
                          </div>

                          {activeItem.parsed.inferredLevel ? (
                            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                              Filename inferred: {activeItem.parsed.inferredLevel}
                            </span>
                          ) : (
                            <span className="text-[11px] text-[var(--text-muted)]">
                              No level in filename
                            </span>
                          )}
                        </div>

                        {/* Column Mapping Controls */}
                        <div className="p-3.5 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)]/50 space-y-2.5">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <h4 className="text-xs font-bold text-[var(--text)]">
                              Column Mapping
                            </h4>
                            {activeItem.mapping.levelCol === -1 && activeItem.parsed.inferredLevel && (
                              <span className="text-[11px] text-emerald-700 dark:text-emerald-300 font-medium">
                                No level column mapped — using inferred level <strong>{activeItem.parsed.inferredLevel}</strong> from filename
                              </span>
                            )}
                          </div>

                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                            {mappingFields.map(({ key, label, required }) => (
                              <label key={key} className="space-y-1 block">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] block">
                                  {label}
                                  {required ? ' *' : ''}
                                </span>
                                <select
                                  value={activeItem.mapping[key]}
                                  onChange={(e) => updatePreviewMapping(key, Number(e.target.value))}
                                  className="w-full px-2 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] text-xs font-medium focus:outline-none focus:ring-2 focus:ring-amber-500"
                                >
                                  {!required && <option value={-1}>— None —</option>}
                                  {activeItem.parsed.headers.map((h, colIdx) => (
                                    <option key={colIdx} value={colIdx}>
                                      {h} (col {colIdx + 1})
                                    </option>
                                  ))}
                                </select>
                              </label>
                            ))}
                          </div>
                        </div>

                        {/* 5-Row Preview Table */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-bold text-[var(--text)]">
                              5-Row Preview
                            </span>
                            <span className="text-[11px] text-[var(--text-muted)]">
                              Showing {previewRows.length} of {activeItem.parsed.rows.length.toLocaleString()} rows • Accepts N5, n5, 5, "level 5" (ignores outside 1–5)
                            </span>
                          </div>

                          <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                            <table className="w-full text-left border-collapse text-xs">
                              <thead>
                                <tr className="bg-[var(--surface-muted)] border-b border-[var(--border)] text-[11px]">
                                  <th className="py-2 px-2.5 font-bold text-[var(--text-muted)]">#</th>
                                  {activeItem.parsed.headers.map((h, colIdx) => {
                                    const roles: string[] = [];
                                    if (activeItem.mapping.charCol === colIdx) roles.push('Kanji');
                                    if (activeItem.mapping.levelCol === colIdx) roles.push('Level');
                                    if (activeItem.mapping.readingCol === colIdx) roles.push('Reading');
                                    if (activeItem.mapping.onCol === colIdx) roles.push('On');
                                    if (activeItem.mapping.kunCol === colIdx) roles.push('Kun');
                                    if (activeItem.mapping.meaningCol === colIdx) roles.push('Meaning');
                                    if (activeItem.mapping.strokeCol === colIdx) roles.push('Strokes');
                                    return (
                                      <th key={colIdx} className="py-2 px-2.5 font-bold text-[var(--text)] whitespace-nowrap">
                                        <div>{h}</div>
                                        {roles.length > 0 && (
                                          <span className="inline-block mt-0.5 text-[10px] px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 font-semibold">
                                            → {roles.join(', ')}
                                          </span>
                                        )}
                                      </th>
                                    );
                                  })}
                                  <th className="py-2 px-2.5 font-bold text-indigo-700 dark:text-indigo-300 whitespace-nowrap bg-indigo-50/50 dark:bg-indigo-950/30">
                                    Parsed Result
                                  </th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-[var(--border)]">
                                {previewRows.map((pRow) => (
                                  <tr key={pRow.rowIndex} className="hover:bg-[var(--surface-muted)]/40">
                                    <td className="py-2 px-2.5 font-mono text-[11px] text-[var(--text-muted)]">
                                      {pRow.rowIndex}
                                    </td>
                                    {activeItem.parsed.headers.map((_, colIdx) => (
                                      <td
                                        key={colIdx}
                                        className={`py-2 px-2.5 max-w-[180px] truncate ${
                                          colIdx === activeItem.mapping.charCol ? 'font-bold text-sm' : ''
                                        }`}
                                        title={pRow.rawRow[colIdx] || ''}
                                      >
                                        {pRow.rawRow[colIdx] || <span className="text-[var(--text-muted)] opacity-50">—</span>}
                                      </td>
                                    ))}
                                    <td className="py-2 px-2.5 whitespace-nowrap bg-indigo-50/30 dark:bg-indigo-950/20">
                                      {pRow.status === 'skipped' ? (
                                        <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                                          Skipped (not kanji)
                                        </span>
                                      ) : pRow.status === 'ignored-level' ? (
                                        <span
                                          className="text-[11px] px-2 py-0.5 rounded-full font-semibold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                                          title={pRow.statusReason}
                                        >
                                          {pRow.character} → {pRow.jlptLevel} ({pRow.statusReason})
                                        </span>
                                      ) : (
                                        <span className="text-[11px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                                          {pRow.character} → {pRow.jlptLevel}
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* Preview Action Buttons */}
                        <div className="flex items-center justify-between gap-2 pt-2">
                          <button
                            onClick={() => {
                              setKanjiPreviewFiles([]);
                              setActivePreviewIndex(0);
                              setImportError(null);
                            }}
                            className="px-3.5 py-2 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] transition"
                          >
                            Choose Different File(s)
                          </button>
                          <button
                            onClick={handleConfirmKanjiPreviewImport}
                            className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-sm transition active:scale-95 flex items-center gap-1.5"
                          >
                            <Upload className="w-3.5 h-3.5" />
                            Confirm & Import ({totalRowsAllFiles.toLocaleString()} rows)
                          </button>
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <div className="border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-6 sm:p-8 text-center space-y-3 hover:border-indigo-500 transition">
                    <Upload className="w-10 h-10 text-indigo-500 mx-auto" />
                    <div>
                      <p className="text-sm font-bold text-slate-900 dark:text-white">
                        Select {selectedKind === 'kanji-levels' ? 'Kanji CSV, TSV, or JSON file(s)' : `${selectedKind.toUpperCase()} file`}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        Supports <code className="font-mono">.csv</code>, <code className="font-mono">.tsv</code>, <code className="font-mono">.json</code>, <code className="font-mono">.gz</code>, or <code className="font-mono">.zip</code>
                        {selectedKind === 'kanji-levels' && ' (select one or multiple files)'}
                      </p>
                    </div>

                    {/* CSV / TSV / JSON Documentation & Disclaimers based on selectedKind */}
                    {selectedKind === 'kanji-levels' && (
                      <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-left text-xs space-y-1.5 max-w-md mx-auto">
                        <div className="font-bold text-amber-900 dark:text-amber-300 flex items-center gap-1.5">
                          <Sparkles className="w-4 h-4 text-amber-500" />
                          <span>Supported Kanji List Formats (CSV, TSV, JSON)</span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-400">
                          • <strong>CSV / TSV</strong>: <code className="font-mono font-semibold">character, level (optional), readings, meanings, strokes</code>
                        </p>
                        <p className="text-slate-600 dark:text-slate-400">
                          • <strong>JSON</strong>: object map <code className="font-mono">{`{"気": 5}`}</code> or array <code className="font-mono">{`[{"kanji": "気", "jlpt": 5}]`}</code>
                        </p>
                        <div className="p-2 rounded bg-white/80 dark:bg-slate-900/80 font-mono text-[11px] text-slate-700 dark:text-slate-300 border border-amber-100 dark:border-amber-900">
                          character,level,reading,meaning,strokes<br />
                          学,N5,ガク・まなぶ,study; learning,8<br />
                          気,level 5,キ,spirit,6<br />
                          違,3,イ・ちがう,differ; wrong,13
                        </div>
                        <div className="text-[11px] text-amber-800 dark:text-amber-300 space-y-0.5 pt-0.5">
                          <div>• <strong>Levels</strong>: <code className="font-mono">N5</code>, <code className="font-mono">n5</code>, <code className="font-mono">5</code>, or <code className="font-mono">"level 5"</code> all map to N5. Values outside 1–5 are ignored.</div>
                          <div>• <strong>Auto-detect & preview</strong>: Detects kanji column, infers level from filename (e.g. <code className="font-mono">kanji-n5.csv</code> → N5), and shows a 5-row column mapping preview.</div>
                          <div>• <strong>Duplicates</strong>: Keeps the easier level (N5 &gt; N4 &gt; N3 &gt; N2 &gt; N1).</div>
                        </div>
                      </div>
                    )}

                    {selectedKind === 'jlpt' && (
                      <div className="p-3 rounded-xl bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 text-left text-xs space-y-1.5 max-w-md mx-auto">
                        <div className="font-bold text-sky-900 dark:text-sky-300 flex items-center gap-1.5">
                          <Award className="w-4 h-4 text-sky-500" />
                          <span>JLPT Vocabulary CSV Format Specification</span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-400">
                          Columns: <code className="font-mono font-semibold">expression, reading (optional), level (N5-N1)</code>
                        </p>
                        <div className="p-2 rounded bg-white/80 dark:bg-slate-900/80 font-mono text-[11px] text-slate-700 dark:text-slate-300 border border-sky-100 dark:border-sky-900">
                          expression,reading,level<br />
                          日本,にほん,N5<br />
                          桜,さくら,N5<br />
                          食べる,たべる,N5
                        </div>
                        <p className="text-[11px] text-amber-700 dark:text-amber-400 font-medium pt-1">
                          Notice: JLPT vocabulary lists are unofficial community lists. Official JLPT specifications do not publish fixed vocabulary lists.
                        </p>
                      </div>
                    )}

                    {selectedKind === 'frequency' && (
                      <div className="p-3 rounded-xl bg-teal-50 dark:bg-teal-950/40 border border-teal-200 dark:border-teal-800 text-left text-xs space-y-1.5 max-w-md mx-auto">
                        <div className="font-bold text-teal-900 dark:text-teal-300 flex items-center gap-1.5">
                          <BarChart3 className="w-4 h-4 text-teal-500" />
                          <span>Frequency CSV Format Specification</span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-400">
                          Columns: <code className="font-mono font-semibold">word, rank</code> (or count)
                        </p>
                        <div className="p-2 rounded bg-white/80 dark:bg-slate-900/80 font-mono text-[11px] text-slate-700 dark:text-slate-300 border border-teal-100 dark:border-teal-900">
                          word,rank<br />
                          日本,120<br />
                          見る,180<br />
                          食べる,350
                        </div>
                        <p className="text-[11px] text-teal-700 dark:text-teal-300">
                          Matches by kanji form and reading, overriding priority-tag frequency bands.
                        </p>
                      </div>
                    )}

                    <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                      ✓ Multiple packs coexist and merge by upsert; never deletes existing packs.
                    </p>

                    <label className="inline-block px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-sm">
                      {selectedKind === 'kanji-levels' ? 'Browse Kanji File(s)' : 'Browse Local File'}
                      <input
                        type="file"
                        accept=".csv,.tsv,.json,.gz,.zip,.txt"
                        multiple={selectedKind === 'kanji-levels'}
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </label>
                  </div>
                )}
              </div>
            )}

            {/* Tab 2: URL download */}
            {!isImporting && importTab === 'url' && (
              <div className="space-y-3 py-2">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block">
                    Direct URL to JSON / GZ / ZIP
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      placeholder="https://.../dictionary.json"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      className="flex-1 px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <button
                      onClick={handleUrlImport}
                      disabled={!urlInput.trim()}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition shadow-xs shrink-0"
                    >
                      Download & Index
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Tab 3: Bundled Samples for multi-pack testing */}
            {!isImporting && importTab === 'sample' && (
              <div className="space-y-2 py-1">
                <p className="text-xs text-slate-500">
                  Select sample datasets to test multi-pack coexistence and source grouping:
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {/* Sample 1: JMdict Common */}
                  <button
                    onClick={() =>
                      handleSampleImport(
                        '/dict/jmdict-eng-common-sample.json',
                        'jmdict-eng-common-sample.json',
                        'dictionary'
                      )
                    }
                    className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 text-left hover:border-indigo-500 transition space-y-1"
                  >
                    <div className="flex items-center gap-1.5 font-bold text-slate-900 dark:text-white">
                      <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
                      <span>JMdict Common Sample</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      8 high-frequency everyday words (日本, 桜, 学校, 先生, 猫, 犬, 電車...)
                    </p>
                  </button>

                  {/* Sample 2: JMdict Full */}
                  <button
                    onClick={() =>
                      handleSampleImport(
                        '/dict/jmdict-eng-sample.json',
                        'jmdict-eng-sample.json',
                        'dictionary'
                      )
                    }
                    className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 text-left hover:border-indigo-500 transition space-y-1"
                  >
                    <div className="flex items-center gap-1.5 font-bold text-slate-900 dark:text-white">
                      <BookOpen className="w-3.5 h-3.5 text-indigo-500" />
                      <span>JMdict Extended Sample</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      19 full JMdict entries with priority scores (merges overlapping words)
                    </p>
                  </button>

                  {/* Sample 3: JMnedict Names */}
                  <button
                    onClick={() =>
                      handleSampleImport(
                        '/dict/jmnedict-names-sample.json',
                        'jmnedict-names-sample.json',
                        'names'
                      )
                    }
                    className="p-3 rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/30 dark:bg-emerald-950/20 text-left hover:border-emerald-500 transition space-y-1"
                  >
                    <div className="flex items-center gap-1.5 font-bold text-emerald-800 dark:text-emerald-300">
                      <Sparkles className="w-3.5 h-3.5 text-emerald-500" />
                      <span>JMnedict Names Sample</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Names dictionary (田中, 佐藤, 東京, 富士山, 桃太郎, 太郎)
                    </p>
                  </button>

                  {/* Sample 4: JLPT Community Sample (CSV) */}
                  <button
                    onClick={() =>
                      handleSampleImport(
                        '/dict/jlpt-community-sample.csv',
                        'jlpt-community-sample.csv',
                        'jlpt'
                      )
                    }
                    className="p-3 rounded-xl border border-sky-200 dark:border-sky-900/60 bg-sky-50/30 dark:bg-sky-950/20 text-left hover:border-sky-500 transition space-y-1"
                  >
                    <div className="flex items-center gap-1.5 font-bold text-sky-800 dark:text-sky-300">
                      <Award className="w-3.5 h-3.5 text-sky-500" />
                      <span>JLPT Community Sample (CSV)</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      CSV format (日本, 桜, 公園, 食べる... N5-N1). Unofficial community list.
                    </p>
                  </button>

                  {/* Sample 5: Frequency Ranking Sample (CSV) */}
                  <button
                    onClick={() =>
                      handleSampleImport(
                        '/dict/frequency-sample.csv',
                        'frequency-sample.csv',
                        'frequency'
                      )
                    }
                    className="p-3 rounded-xl border border-teal-200 dark:border-teal-900/60 bg-teal-50/30 dark:bg-teal-950/20 text-left hover:border-teal-500 transition space-y-1"
                  >
                    <div className="flex items-center gap-1.5 font-bold text-teal-800 dark:text-teal-300">
                      <BarChart3 className="w-3.5 h-3.5 text-teal-500" />
                      <span>Word Frequency Sample (CSV)</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      CSV ranking (word, rank). Maps to frequency bands (Top 500, Top 1,000, etc.).
                    </p>
                  </button>

                  {/* Sample 6: Kanji JLPT List (CSV) */}
                  <button
                    onClick={() =>
                      handleSampleImport(
                        '/dict/kanji-jlpt-sample.csv',
                        'kanji-jlpt-sample.csv',
                        'kanji-levels'
                      )
                    }
                    className="p-3 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/30 dark:bg-amber-950/20 text-left hover:border-amber-500 transition space-y-1"
                  >
                    <div className="flex items-center gap-1.5 font-bold text-amber-800 dark:text-amber-300">
                      <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                      <span>JLPT Kanji List Sample (CSV)</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Individual kanji (学 N5, 校 N5, 食 N5, 違 N3, 鑑 N1) with readings, meanings, strokes.
                    </p>
                  </button>

                  {/* Sample 7: N5 Kanji (Filename-inferred Level) */}
                  <button
                    onClick={() =>
                      handleSampleImport(
                        '/dict/n5_kanji.csv',
                        'n5_kanji.csv',
                        'kanji-levels'
                      )
                    }
                    className="p-3 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/30 dark:bg-amber-950/20 text-left hover:border-amber-500 transition space-y-1"
                  >
                    <div className="flex items-center gap-1.5 font-bold text-amber-800 dark:text-amber-300">
                      <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                      <span>N5 Kanji (Filename-Inferred Level)</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Demonstrates level inference from filename <code className="font-mono">n5_kanji.csv</code> without explicit level column.
                    </p>
                  </button>
                </div>
              </div>
            )}

            {/* Live Progress Bar & Status while importing */}
            {isImporting && (
              <div className="py-6 space-y-4 text-center">
                <div className="flex items-center justify-center gap-2 text-indigo-600 dark:text-indigo-400">
                  <Loader2 className="w-6 h-6 animate-spin" />
                  <span className="font-bold text-sm">Indexing & Upserting in Web Worker...</span>
                </div>

                <div className="space-y-1.5 max-w-md mx-auto">
                  <div className="flex justify-between text-xs font-semibold text-slate-600 dark:text-slate-400">
                    <span className="truncate">{importStatusMessage}</span>
                    <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400">
                      {importProgress}%
                    </span>
                  </div>
                  <div className="w-full h-3 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden p-0.5 border border-slate-200 dark:border-slate-700">
                    <div
                      style={{ width: `${importProgress}%` }}
                      className="h-full bg-gradient-to-r from-indigo-600 to-purple-600 rounded-full transition-all duration-150"
                    />
                  </div>
                </div>

                <p className="text-[11px] text-slate-400">
                  Merging overlapping entries and preserving coexisting packs.
                </p>

                <div className="pt-2">
                  <button
                    onClick={handleCancelImport}
                    className="px-4 py-1.5 rounded-xl border border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-xs font-bold transition"
                  >
                    Cancel Import
                  </button>
                </div>
              </div>
            )}

            {/* Error Message */}
            {importError && (
              <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-xl text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{importError}</span>
              </div>
            )}

            {/* Modal Footer */}
            {!isImporting && (
              <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
                <button
                  onClick={() => setShowImportModal(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Import Summary Modal (Requirement 2 & 5: matched, unmatched, ambiguous) */}
      {importSummary?.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl overflow-hidden p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                <h3 className="font-bold text-base text-slate-900 dark:text-white">
                  Import Summary
                </h3>
              </div>
              <button
                onClick={() => setImportSummary(null)}
                className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/80 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 dark:text-slate-400">File Name:</span>
                  <span className="font-bold font-mono text-slate-900 dark:text-white truncate max-w-[240px]">
                    {importSummary.fileName}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 dark:text-slate-400">Dataset Kind:</span>
                  <span className="font-bold uppercase px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                    {importSummary.kind}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 dark:text-slate-400">
                    {importSummary.kind === 'kanji-levels' ? 'Characters Imported:' : 'Total Entries Parsed:'}
                  </span>
                  <span className="font-bold font-mono text-slate-900 dark:text-white">
                    {importSummary.count.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* For kanji-levels: show only characters imported, per-level counts, duplicates, skipped rows */}
              {importSummary.kind === 'kanji-levels' ? (
                <div className="space-y-3 pt-1">
                  {/* Per-level counts grid */}
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 block">
                      Per-Level Kanji Breakdown:
                    </span>
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 text-center">
                      {(['N5', 'N4', 'N3', 'N2', 'N1', 'No level'] as const).map((lvl) => {
                        const cnt = importSummary.perLevelCounts?.[lvl] || 0;
                        const colors: Record<string, string> = {
                          N5: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
                          N4: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800',
                          N3: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
                          N2: 'bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-800',
                          N1: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800',
                          'No level': 'bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700',
                        };
                        return (
                          <div
                            key={lvl}
                            className={`p-2 rounded-xl border ${colors[lvl]} flex flex-col items-center justify-center`}
                          >
                            <span className="text-[10px] font-bold block">{lvl}</span>
                            <span className="text-sm font-mono font-bold">{cnt.toLocaleString()}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Duplicates & Skipped info */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-3 rounded-2xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                      <span className="text-[10px] uppercase font-bold text-amber-700 dark:text-amber-400 block">
                        Duplicates
                      </span>
                      <span className="text-base font-bold font-mono text-amber-800 dark:text-amber-300">
                        {(importSummary.duplicateCount || 0).toLocaleString()}
                      </span>
                      <span className="text-[10px] text-amber-600 dark:text-amber-400 block mt-0.5">
                        Easier level retained
                      </span>
                    </div>

                    <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700">
                      <span className="text-[10px] uppercase font-bold text-slate-500 block">
                        Skipped Rows
                      </span>
                      <span className="text-base font-bold font-mono text-slate-700 dark:text-slate-300">
                        {(importSummary.skippedCount || 0).toLocaleString()}
                      </span>
                      <span className="text-[10px] text-slate-400 block mt-0.5">
                        Not a single kanji character
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* Matched / Ambiguous / Unmatched Grid */}
                  {(importSummary.matchedCount !== undefined ||
                    importSummary.unmatchedCount !== undefined ||
                    importSummary.ambiguousCount !== undefined) && (
                    <div className="grid grid-cols-3 gap-2 pt-1 text-center">
                      <div className="p-3 rounded-2xl bg-emerald-50/80 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800">
                        <span className="text-[10px] uppercase font-bold text-emerald-600 dark:text-emerald-400 block">
                          Matched
                        </span>
                        <span className="text-base font-bold font-mono text-emerald-700 dark:text-emerald-300">
                          {(importSummary.matchedCount || 0).toLocaleString()}
                        </span>
                      </div>
                      <div className="p-3 rounded-2xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                        <span className="text-[10px] uppercase font-bold text-amber-600 dark:text-amber-400 block">
                          Ambiguous
                        </span>
                        <span className="text-base font-bold font-mono text-amber-700 dark:text-amber-300">
                          {(importSummary.ambiguousCount || 0).toLocaleString()}
                        </span>
                      </div>
                      <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700">
                        <span className="text-[10px] uppercase font-bold text-slate-500 block">
                          Unmatched
                        </span>
                        <span className="text-base font-bold font-mono text-slate-700 dark:text-slate-300">
                          {(importSummary.unmatchedCount || 0).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Unmatched sample list if any */}
                  {importSummary.unmatchedSample && importSummary.unmatchedSample.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-[11px] font-bold text-slate-500 block">
                        Unmatched Sample (not found in current dictionary):
                      </span>
                      <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 max-h-24 overflow-y-auto font-mono text-[11px] text-slate-600 dark:text-slate-300 flex flex-wrap gap-1.5">
                        {importSummary.unmatchedSample.slice(0, 15).map((u: any, idx: number) => (
                          <span
                            key={idx}
                            className="px-1.5 py-0.5 rounded bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600"
                          >
                            {u.expression || u.word || String(u)}
                          </span>
                        ))}
                        {importSummary.unmatchedSample.length > 15 && (
                          <span className="text-slate-400 self-center">
                            +{importSummary.unmatchedSample.length - 15} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {importSummary.kind === 'jlpt' && (
                    <p className="text-[11px] text-slate-400 italic">
                      Notice: JLPT vocabulary lists are unofficial community lists. Official JLPT specifications do not publish fixed vocabulary lists.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
              <button
                onClick={() => setImportSummary(null)}
                className="px-5 py-2 text-xs font-bold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
