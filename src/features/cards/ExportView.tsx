import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  db,
  type CardItem,
  type CardType,
  type DeckItem,
  type ExportHistoryItem,
} from '../../db/db';
import {
  buildAnkiExportPlan,
  buildCsvTsvExport,
  formatAnkiDeckName,
  formatExportFilename,
  CSV_COLUMN_LABELS,
  type ApkgVerificationReport,
  type CsvColumnKey,
  type FuriganaExportFormat,
  type SqliteBuildProgress,
} from '../../core/ankiExportCore';
import type {
  AnkiExportWorkerRequest,
  AnkiExportWorkerResponse,
} from './ankiExport.worker';
import { useAppStore } from '../../store/useAppStore';
import { packSupportsRuby } from '../../core/languagePack';
import { getLanguagePack } from '../../packs/registry';
import { FuriganaText } from '../../ui/FuriganaText';
import {
  ArrowLeft,
  Download,
  FileArchive,
  FileSpreadsheet,
  Filter,
  CheckCircle2,
  AlertCircle,
  Loader2,
  X,
  ArrowUp,
  ArrowDown,
  ShieldCheck,
  HelpCircle,
  History,
  RotateCcw,
  Sparkles,
  Info,
  Trash2,
} from 'lucide-react';

const CARD_TYPE_LABELS: Record<CardType, string> = {
  word_to_meaning: 'Word → Meaning',
  meaning_to_word: 'Meaning → Word',
  reading: 'Reading',
  cloze: 'Cloze',
  listening: 'Listening',
};

const DEFAULT_CSV_COLUMNS: CsvColumnKey[] = [
  'word',
  'reading',
  'furiganaHtml',
  'furiganaAnki',
  'meaning',
  'partOfSpeech',
  'level',
  'frequency',
  'sentence',
  'sentenceFuriganaHtml',
  'source',
  'notes',
  'deck',
  'tags',
];

const ALL_CSV_COLUMNS: CsvColumnKey[] = [
  'word',
  'lemma',
  'reading',
  'furiganaHtml',
  'furiganaAnki',
  'meaning',
  'partOfSpeech',
  'level',
  'frequency',
  'sentence',
  'sentenceFuriganaHtml',
  'sentenceMeaning',
  'source',
  'notes',
  'deck',
  'cardType',
  'clozeText',
  'tags',
];

const ANKI_FRIENDLY_CSV_COLUMNS: CsvColumnKey[] = [
  'word',
  'lemma',
  'reading',
  'furiganaHtml',
  'furiganaAnki',
  'meaning',
  'partOfSpeech',
  'level',
  'frequency',
  'sentence',
  'sentenceFuriganaHtml',
  'source',
  'notes',
  'tags',
];

interface ReadyDownloadArtifact {
  id: string;
  fileName: string;
  format: 'apkg' | 'csv' | 'tsv';
  blobUrl: string;
  byteSize: number;
  cardCount: number;
  noteCount: number;
  verification?: ApkgVerificationReport;
  exportedCardIds: string[];
  deckNames: string[];
  recordedInHistory: boolean;
}

export const ExportView: React.FC = () => {
  const { activeLanguageId, furiganaMode } = useAppStore();
  const pack = getLanguagePack(activeLanguageId);
  const supportsRuby = packSupportsRuby(pack);

  const [cards, setCards] = useState<CardItem[]>([]);
  const [decks, setDecks] = useState<DeckItem[]>([]);
  const [exportHistory, setExportHistory] = useState<ExportHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filters
  const [selectedDeckIds, setSelectedDeckIds] = useState<Set<string>>(new Set());
  const [selectedCardTypes, setSelectedCardTypes] = useState<Set<CardType>>(
    new Set(['word_to_meaning', 'meaning_to_word', 'reading', 'cloze', 'listening'])
  );
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [onlyNotYetExported, setOnlyNotYetExported] = useState<boolean>(false);
  const [excludeSuspended, setExcludeSuspended] = useState<boolean>(true);

  // Format & Export Options
  const [exportFormat, setExportFormat] = useState<'apkg' | 'csv'>('apkg');
  const [furiganaFormat, setFuriganaFormat] = useState<FuriganaExportFormat>('both');
  const [useSubdeckPrefix, setUseSubdeckPrefix] = useState<boolean>(true);
  const [includeAutoLevelTag, setIncludeAutoLevelTag] = useState<boolean>(true);
  const [includeAutoSourceTag, setIncludeAutoSourceTag] = useState<boolean>(true);
  const [includeAutoCardTypeTag, setIncludeAutoCardTypeTag] = useState<boolean>(false);

  // CSV/TSV Options
  const [csvDelimiter, setCsvDelimiter] = useState<',' | '\t'>('\t');
  const [csvIncludeHeader, setCsvIncludeHeader] = useState<boolean>(true);
  const [csvIncludeBom, setCsvIncludeBom] = useState<boolean>(true);
  const [csvAllowHtml, setCsvAllowHtml] = useState<boolean>(true);
  const [csvColumns, setCsvColumns] = useState<CsvColumnKey[]>(DEFAULT_CSV_COLUMNS);

  // Worker & Job Status
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<SqliteBuildProgress | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [readyArtifact, setReadyArtifact] = useState<ReadyDownloadArtifact | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const readyBlobUrlRef = useRef<string | null>(null);

  const revokeReadyBlob = useCallback(() => {
    if (readyBlobUrlRef.current) {
      URL.revokeObjectURL(readyBlobUrlRef.current);
      readyBlobUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      revokeReadyBlob();
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [revokeReadyBlob]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [deckRows, cardRows, historyRows] = await Promise.all([
        db.decks.where('languageId').equals(activeLanguageId).toArray(),
        db.cards.where('languageId').equals(activeLanguageId).toArray(),
        db.exportHistory.orderBy('exportedAt').reverse().limit(30).toArray(),
      ]);

      deckRows.sort((a, b) => a.createdAt - b.createdAt);
      setDecks(deckRows);
      setCards(cardRows);
      setExportHistory(historyRows);
      setSelectedDeckIds(new Set(deckRows.map((d) => d.id)));
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load flashcards and export history.');
    } finally {
      setIsLoading(false);
    }
  }, [activeLanguageId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const deckNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of decks) m.set(d.id, d.name);
    return m;
  }, [decks]);

  const deckCardCountMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards) {
      m.set(c.deckId, (m.get(c.deckId) || 0) + 1);
    }
    return m;
  }, [cards]);

  const availableLevels = useMemo(() => {
    const set = new Set<string>();
    for (const c of cards) {
      if (c.level?.trim()) set.add(c.level.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [cards]);

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of cards) {
      for (const t of c.tags || []) {
        if (t.trim()) set.add(t.trim());
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [cards]);

  const availableSources = useMemo(() => {
    const set = new Set<string>();
    for (const c of cards) {
      if (c.sourceDocTitle?.trim()) set.add(c.sourceDocTitle.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [cards]);

  const filteredCards = useMemo(() => {
    const fromMs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toMs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;

    return cards.filter((c) => {
      if (selectedDeckIds.size > 0 && !selectedDeckIds.has(c.deckId)) return false;
      if (selectedDeckIds.size === 0) return false;
      if (!selectedCardTypes.has(c.cardType)) return false;
      if (excludeSuspended && c.suspended) return false;
      if (onlyNotYetExported && c.exportedAt) return false;
      if (levelFilter !== 'all' && (c.level || '') !== levelFilter) return false;
      if (sourceFilter !== 'all' && (c.sourceDocTitle || '') !== sourceFilter) return false;
      if (tagFilter !== 'all' && !(c.tags || []).includes(tagFilter)) return false;
      if (fromMs !== null && !Number.isNaN(fromMs) && c.createdAt < fromMs) return false;
      if (toMs !== null && !Number.isNaN(toMs) && c.createdAt > toMs) return false;
      return true;
    });
  }, [
    cards,
    selectedDeckIds,
    selectedCardTypes,
    excludeSuspended,
    onlyNotYetExported,
    levelFilter,
    sourceFilter,
    tagFilter,
    dateFrom,
    dateTo,
  ]);

  const exportPlanPreview = useMemo(() => {
    return buildAnkiExportPlan(filteredCards, decks, {
      furiganaFormat,
      useSubdeckPrefix,
      subdeckRootName: 'LinguaForge',
      languageName: pack.name,
      ttsLangCode: pack.ttsCode,
      includeAutoLevelTag,
      includeAutoSourceTag,
      includeAutoCardTypeTag,
    });
  }, [
    filteredCards,
    decks,
    furiganaFormat,
    useSubdeckPrefix,
    pack.name,
    pack.ttsCode,
    includeAutoLevelTag,
    includeAutoSourceTag,
    includeAutoCardTypeTag,
  ]);

  const previewRows = useMemo(() => filteredCards.slice(0, 10), [filteredCards]);

  const toggleDeckSelection = (deckId: string) => {
    setSelectedDeckIds((prev) => {
      const next = new Set(prev);
      if (next.has(deckId)) next.delete(deckId);
      else next.add(deckId);
      return next;
    });
  };

  const toggleCardTypeSelection = (cardType: CardType) => {
    setSelectedCardTypes((prev) => {
      const next = new Set(prev);
      if (next.has(cardType)) next.delete(cardType);
      else next.add(cardType);
      return next;
    });
  };

  const resetFilters = () => {
    setSelectedDeckIds(new Set(decks.map((d) => d.id)));
    setSelectedCardTypes(
      new Set(['word_to_meaning', 'meaning_to_word', 'reading', 'cloze', 'listening'])
    );
    setTagFilter('all');
    setLevelFilter('all');
    setSourceFilter('all');
    setDateFrom('');
    setDateTo('');
    setOnlyNotYetExported(false);
    setExcludeSuspended(true);
  };

  const applyAnkiFriendlyCsvPreset = () => {
    setCsvDelimiter('\t');
    setCsvIncludeHeader(false);
    setCsvIncludeBom(true);
    setCsvAllowHtml(true);
    setCsvColumns([...ANKI_FRIENDLY_CSV_COLUMNS]);
  };

  const toggleCsvColumn = (col: CsvColumnKey) => {
    setCsvColumns((prev) => {
      if (prev.includes(col)) {
        if (prev.length <= 1) return prev;
        return prev.filter((c) => c !== col);
      }
      return [...prev, col];
    });
  };

  const moveCsvColumn = (index: number, delta: -1 | 1) => {
    setCsvColumns((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      const [item] = copy.splice(index, 1);
      copy.splice(target, 0, item);
      return copy;
    });
  };

  const triggerDownloadAndRecord = useCallback(
    async (artifact: ReadyDownloadArtifact) => {
      // Trigger browser download
      const a = document.createElement('a');
      a.href = artifact.blobUrl;
      a.download = artifact.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      if (artifact.recordedInHistory) return;

      const now = Date.now();
      try {
        await db.transaction('rw', [db.cards, db.exportHistory], async () => {
          for (const cardId of artifact.exportedCardIds) {
            await db.cards.update(cardId, { exportedAt: now });
          }
          await db.exportHistory.put({
            id: artifact.id,
            exportedAt: now,
            fileName: artifact.fileName,
            format: artifact.format,
            languageId: activeLanguageId,
            cardCount: artifact.cardCount,
            noteCount: artifact.noteCount,
            deckNames: artifact.deckNames,
          });
        });

        setReadyArtifact((prev) =>
          prev && prev.id === artifact.id ? { ...prev, recordedInHistory: true } : prev
        );
        setCards((prev) =>
          prev.map((c) =>
            artifact.exportedCardIds.includes(c.id) ? { ...c, exportedAt: now } : c
          )
        );
        const updatedHistory = await db.exportHistory
          .orderBy('exportedAt')
          .reverse()
          .limit(30)
          .toArray();
        setExportHistory(updatedHistory);
      } catch (err) {
        console.warn('Failed to persist export timestamp/history:', err);
      }
    },
    [activeLanguageId]
  );

  const handleCancelExport = () => {
    const jobId = activeJobIdRef.current;
    if (workerRef.current && jobId) {
      workerRef.current.postMessage({
        type: 'cancel',
        jobId,
      } satisfies AnkiExportWorkerRequest);
    }
    setIsExporting(false);
    setExportProgress(null);
    activeJobIdRef.current = null;
  };

  const handleGenerateExport = async () => {
    if (filteredCards.length === 0) return;

    setExportError(null);
    revokeReadyBlob();
    setReadyArtifact(null);

    if (exportFormat === 'csv') {
      try {
        const ext = csvDelimiter === '\t' ? 'tsv' : 'csv';
        const { bytes } = buildCsvTsvExport(filteredCards, decks, {
          columns: csvColumns,
          delimiter: csvDelimiter,
          includeHeader: csvIncludeHeader,
          includeBom: csvIncludeBom,
          allowHtml: csvAllowHtml,
          furiganaFormat,
          includeAutoLevelTag,
          includeAutoSourceTag,
          includeAutoCardTypeTag,
        });

        const blob = new Blob([bytes.buffer as ArrayBuffer], {
          type:
            csvDelimiter === '\t'
              ? 'text/tab-separated-values;charset=utf-8'
              : 'text/csv;charset=utf-8',
        });
        const blobUrl = URL.createObjectURL(blob);
        readyBlobUrlRef.current = blobUrl;

        const fileName = formatExportFilename(activeLanguageId, ext);
        const deckNames = Array.from(
          new Set(filteredCards.map((c) => deckNameMap.get(c.deckId) || 'Default'))
        );

        const artifact: ReadyDownloadArtifact = {
          id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          fileName,
          format: ext,
          blobUrl,
          byteSize: bytes.byteLength,
          cardCount: filteredCards.length,
          noteCount: exportPlanPreview.notes.length,
          exportedCardIds: filteredCards.map((c) => c.id),
          deckNames,
          recordedInHistory: false,
        };
        setReadyArtifact(artifact);
        await triggerDownloadAndRecord(artifact);
      } catch (err: any) {
        setExportError(err?.message || 'Failed to build CSV/TSV export.');
      }
      return;
    }

    // .apkg export via Web Worker
    setIsExporting(true);
    setExportProgress({
      phase: 'preparing',
      processed: 0,
      total: Math.max(1, exportPlanPreview.notes.length + exportPlanPreview.cards.length),
      percent: 2,
    });

    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    activeJobIdRef.current = jobId;

    if (!workerRef.current) {
      workerRef.current = new Worker(new URL('./ankiExport.worker.ts', import.meta.url), {
        type: 'module',
      });
    }

    const worker = workerRef.current;

    const handleMessage = async (event: MessageEvent<AnkiExportWorkerResponse>) => {
      const data = event.data;
      if (!data || data.jobId !== jobId) return;

      if (data.type === 'progress') {
        setExportProgress(data.progress);
        return;
      }

      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      activeJobIdRef.current = null;
      setIsExporting(false);

      if (data.type === 'cancelled') {
        setExportProgress(null);
        return;
      }

      if (data.type === 'error') {
        setExportProgress(null);
        setExportError(data.error || 'Failed to generate .apkg package.');
        return;
      }

      if (data.type === 'done') {
        setExportProgress(null);
        if (!data.verification?.ok) {
          setExportError(
            data.verification?.error || 'Self-check failed on generated .apkg file.'
          );
          return;
        }

        const blob = new Blob([data.zipBuffer], { type: 'application/apkg' });
        const blobUrl = URL.createObjectURL(blob);
        readyBlobUrlRef.current = blobUrl;

        const fileName = formatExportFilename(activeLanguageId, 'apkg');
        const artifact: ReadyDownloadArtifact = {
          id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          fileName,
          format: 'apkg',
          blobUrl,
          byteSize: data.zipBuffer.byteLength,
          cardCount: data.verification.cardCount,
          noteCount: data.verification.noteCount,
          verification: data.verification,
          exportedCardIds: exportPlanPreview.exportedCardIds,
          deckNames: exportPlanPreview.decks.map((d) => d.name),
          recordedInHistory: false,
        };

        setReadyArtifact(artifact);
        await triggerDownloadAndRecord(artifact);
      }
    };

    const handleError = (err: ErrorEvent) => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      activeJobIdRef.current = null;
      setIsExporting(false);
      setExportProgress(null);
      setExportError(err?.message || 'Anki export worker crashed unexpectedly.');
    };

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);

    worker.postMessage({
      type: 'start',
      jobId,
      plan: exportPlanPreview,
      sqlWasmUrl: `${window.location.origin}/sql-wasm.wasm`,
    } satisfies AnkiExportWorkerRequest);
  };

  const handleClearExportHistory = async () => {
    await db.exportHistory.clear();
    setExportHistory([]);
  };

  const phaseLabel = useMemo(() => {
    if (!exportProgress) return '';
    switch (exportProgress.phase) {
      case 'preparing':
        return 'Initializing SQLite WASM & schema v11...';
      case 'writing_notes':
        return `Writing notes (${exportProgress.processed.toLocaleString()} / ${exportProgress.total.toLocaleString()})...`;
      case 'writing_cards':
        return `Writing cards (${exportProgress.processed.toLocaleString()} / ${exportProgress.total.toLocaleString()})...`;
      case 'zipping':
        return 'Packaging legacy .apkg archive...';
      case 'verifying':
        return 'Self-checking collection.anki2 schema & notes...';
    }
  }, [exportProgress]);

  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <div className="flex items-center gap-3 text-sm font-semibold text-[var(--text-muted)]">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-600 dark:text-indigo-400" />
          <span>Loading cards and export options...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text)] pb-16">
      {/* Header */}
      <header className="bg-[var(--surface)] border-b border-[var(--border)] px-4 sm:px-6 py-5">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <Link
                to="/cards"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text)] transition"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Back to Cards</span>
              </Link>
            </div>
            <h1 className="text-2xl font-black tracking-tight flex items-center gap-2 text-[var(--text)]">
              <FileArchive className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
              <span>Export to Anki &amp; CSV</span>
            </h1>
            <p className="text-xs text-[var(--text-muted)]">
              {pack.flagEmoji} {pack.name} · Builds valid Anki 2.1 legacy packages (.apkg) or CSV/TSV completely offline on your device
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Link
              to="/settings"
              className="px-3.5 py-2 min-h-[40px] rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--surface)] text-xs font-semibold text-[var(--text-secondary)] inline-flex items-center gap-1.5 transition"
            >
              <span>Data Settings</span>
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-6xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {loadError && (
          <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 flex items-center justify-between gap-3 text-xs text-rose-800 dark:text-rose-200">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <span>{loadError}</span>
            </div>
            <button
              type="button"
              onClick={loadData}
              className="px-3 py-1.5 rounded-lg bg-rose-600 text-white font-semibold hover:bg-rose-700 transition"
            >
              Retry
            </button>
          </div>
        )}

        {cards.length === 0 ? (
          <div className="p-10 rounded-3xl bg-[var(--surface)] border border-[var(--border)] text-center space-y-3">
            <FileArchive className="w-10 h-10 mx-auto text-[var(--text-muted)] opacity-60" />
            <h2 className="text-base font-bold text-[var(--text)]">
              No {pack.name} cards to export yet
            </h2>
            <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto leading-relaxed">
              Add vocabulary cards from the Reader word popup first, then come back here to export them into an Anki `.apkg` package or CSV/TSV file.
            </p>
            <div className="pt-2">
              <Link
                to="/library"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition"
              >
                <span>Go to Library</span>
              </Link>
            </div>
          </div>
        ) : (
          <>
            {/* Step 1: Filters */}
            <section
              aria-label="Export Filters"
              className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <h2 className="font-bold text-sm text-[var(--text)]">
                    1. Choose what to export
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={resetFilters}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] transition"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset filters</span>
                </button>
              </div>

              {/* Decks Multi-Select */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[var(--text-secondary)]">
                    Decks ({selectedDeckIds.size} / {decks.length} selected)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedDeckIds(new Set(decks.map((d) => d.id)))}
                      className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      Select all
                    </button>
                    <span className="text-[var(--text-muted)]">·</span>
                    <button
                      type="button"
                      onClick={() => setSelectedDeckIds(new Set())}
                      className="text-[11px] font-semibold text-[var(--text-muted)] hover:underline"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {decks.map((deck) => {
                    const checked = selectedDeckIds.has(deck.id);
                    const count = deckCardCountMap.get(deck.id) || 0;
                    return (
                      <button
                        key={deck.id}
                        type="button"
                        onClick={() => toggleDeckSelection(deck.id)}
                        className={`min-h-[40px] px-3 py-1.5 rounded-xl border text-xs font-semibold inline-flex items-center gap-2 transition ${
                          checked
                            ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                            : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-muted)] hover:text-[var(--text)]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {}}
                          tabIndex={-1}
                          className="accent-indigo-600 pointer-events-none"
                        />
                        <span>{deck.name}</span>
                        <span className="text-[11px] opacity-75 tabular-nums">({count})</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Card Types Multi-Select */}
              <div className="space-y-2">
                <span className="text-xs font-semibold text-[var(--text-secondary)] block">
                  Card types
                </span>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      'word_to_meaning',
                      'meaning_to_word',
                      'reading',
                      'cloze',
                      'listening',
                    ] as CardType[]
                  ).map((ct) => {
                      const checked = selectedCardTypes.has(ct);
                      return (
                        <button
                          key={ct}
                          type="button"
                          onClick={() => toggleCardTypeSelection(ct)}
                          className={`min-h-[38px] px-3 py-1.5 rounded-xl border text-xs font-semibold inline-flex items-center gap-2 transition ${
                            checked
                              ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                              : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-muted)] hover:text-[var(--text)]'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {}}
                            tabIndex={-1}
                            className="accent-indigo-600 pointer-events-none"
                          />
                          <span>{CARD_TYPE_LABELS[ct]}</span>
                        </button>
                      );
                    }
                  )}
                </div>
              </div>

              {/* Other Filters Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
                <label className="space-y-1">
                  <span className="font-semibold text-[var(--text-secondary)] block">Tag</span>
                  <select
                    value={tagFilter}
                    onChange={(e) => setTagFilter(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
                  >
                    <option value="all">All tags</option>
                    {availableTags.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1">
                  <span className="font-semibold text-[var(--text-secondary)] block">
                    JLPT / Level
                  </span>
                  <select
                    value={levelFilter}
                    onChange={(e) => setLevelFilter(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
                  >
                    <option value="all">All levels</option>
                    {availableLevels.map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {lvl}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1">
                  <span className="font-semibold text-[var(--text-secondary)] block">
                    Source text
                  </span>
                  <select
                    value={sourceFilter}
                    onChange={(e) => setSourceFilter(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
                  >
                    <option value="all">All sources</option>
                    {availableSources.map((src) => (
                      <option key={src} value={src}>
                        {src}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1">
                  <span className="font-semibold text-[var(--text-secondary)] block">
                    Added from
                  </span>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-semibold text-[var(--text-secondary)] block">
                    Added to
                  </span>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-4 pt-1 text-xs">
                <label className="inline-flex items-center gap-2 cursor-pointer font-medium text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={onlyNotYetExported}
                    onChange={(e) => setOnlyNotYetExported(e.target.checked)}
                    className="w-4 h-4 accent-indigo-600 rounded"
                  />
                  <span>Only cards not yet exported</span>
                </label>

                <label className="inline-flex items-center gap-2 cursor-pointer font-medium text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={excludeSuspended}
                    onChange={(e) => setExcludeSuspended(e.target.checked)}
                    className="w-4 h-4 accent-indigo-600 rounded"
                  />
                  <span>Exclude suspended cards</span>
                </label>
              </div>
            </section>

            {/* Step 2: Format & Options */}
            <section
              aria-label="Format and Options"
              className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-5"
            >
              <h2 className="font-bold text-sm text-[var(--text)]">
                2. Format &amp; Export Settings
              </h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setExportFormat('apkg')}
                  className={`p-4 rounded-2xl border text-left transition flex items-start gap-3 ${
                    exportFormat === 'apkg'
                      ? 'border-indigo-600 bg-[var(--accent-subtle)]'
                      : 'border-[var(--border)] bg-[var(--surface-muted)]/60 hover:border-indigo-400/50'
                  }`}
                >
                  <FileArchive
                    className={`w-5 h-5 shrink-0 mt-0.5 ${
                      exportFormat === 'apkg'
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-[var(--text-muted)]'
                    }`}
                  />
                  <div className="space-y-1">
                    <div className="text-sm font-bold text-[var(--text)]">
                      .apkg (Anki package)
                    </div>
                    <div className="text-xs text-[var(--text-muted)] leading-relaxed">
                      Anki 2.1 legacy SQLite package with custom LinguaForge note type, light/dark templates, ruby furigana, decks, and stable note GUIDs.
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setExportFormat('csv')}
                  className={`p-4 rounded-2xl border text-left transition flex items-start gap-3 ${
                    exportFormat === 'csv'
                      ? 'border-indigo-600 bg-[var(--accent-subtle)]'
                      : 'border-[var(--border)] bg-[var(--surface-muted)]/60 hover:border-indigo-400/50'
                  }`}
                >
                  <FileSpreadsheet
                    className={`w-5 h-5 shrink-0 mt-0.5 ${
                      exportFormat === 'csv'
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-[var(--text-muted)]'
                    }`}
                  />
                  <div className="space-y-1">
                    <div className="text-sm font-bold text-[var(--text)]">
                      CSV / TSV (plain text)
                    </div>
                    <div className="text-xs text-[var(--text-muted)] leading-relaxed">
                      Customizable columns, comma or tab delimiter, optional UTF-8 BOM, and an Anki-friendly import preset.
                    </div>
                  </div>
                </button>
              </div>

              {/* Shared Furigana & Tag Options */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-[var(--border)] text-xs">
                {supportsRuby && (
                  <div className="space-y-2">
                    <label className="font-semibold text-[var(--text-secondary)] block">
                      {pack.id === 'zh' ? 'Pinyin ruby in export' : 'Furigana in export'}
                    </label>
                    <select
                      value={furiganaFormat}
                      onChange={(e) => setFuriganaFormat(e.target.value as FuriganaExportFormat)}
                      className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] font-medium"
                    >
                      <option value="both">Both HTML (&lt;ruby&gt;) and Anki bracket format (漢字[かんじ])</option>
                      <option value="html">HTML only (&lt;ruby&gt;漢字&lt;rt&gt;かんじ&lt;/rt&gt;&lt;/ruby&gt;)</option>
                      <option value="anki">Anki format only (漢字[かんじ])</option>
                    </select>
                  </div>
                )}

                <div className="space-y-2">
                  <span className="font-semibold text-[var(--text-secondary)] block">
                    Automatic tags (spaces converted to underscores)
                  </span>
                  <div className="flex flex-wrap gap-3 pt-1">
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeAutoLevelTag}
                        onChange={(e) => setIncludeAutoLevelTag(e.target.checked)}
                        className="accent-indigo-600"
                      />
                      <span>
                        Level (e.g.{' '}
                        {pack.id === 'ja'
                          ? 'JLPT_N5'
                          : pack.id === 'ko' || pack.id === 'zh'
                          ? pack.levelSystem.defaultLevel.replace(/\s+/g, '_')
                          : `CEFR_${pack.levelSystem.defaultLevel}`}
                        )
                      </span>
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeAutoSourceTag}
                        onChange={(e) => setIncludeAutoSourceTag(e.target.checked)}
                        className="accent-indigo-600"
                      />
                      <span>Source text</span>
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeAutoCardTypeTag}
                        onChange={(e) => setIncludeAutoCardTypeTag(e.target.checked)}
                        className="accent-indigo-600"
                      />
                      <span>Card type</span>
                    </label>
                  </div>
                </div>
              </div>

              {exportFormat === 'apkg' ? (
                <div className="p-4 rounded-2xl bg-[var(--surface-muted)]/70 border border-[var(--border)] space-y-3 text-xs">
                  <label className="inline-flex items-center gap-2 cursor-pointer font-semibold text-[var(--text)]">
                    <input
                      type="checkbox"
                      checked={useSubdeckPrefix}
                      onChange={(e) => setUseSubdeckPrefix(e.target.checked)}
                      className="w-4 h-4 accent-indigo-600 rounded"
                    />
                    <span>Nest decks under parent sub-deck hierarchy (::)</span>
                  </label>
                  <div className="text-[11px] text-[var(--text-muted)]">
                    Deck name in Anki:{' '}
                    <code className="px-1.5 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] font-mono">
                      {formatAnkiDeckName(decks[0]?.name || 'Default', {
                        useSubdeckPrefix,
                        subdeckRootName: 'LinguaForge',
                        languageName: pack.name,
                      })}
                    </code>
                  </div>
                  {exportPlanPreview.hasListeningCards && (
                    <div className="p-3 rounded-xl bg-[var(--surface)] border border-indigo-500/30 flex items-start gap-2 text-[11px] text-[var(--text-secondary)]">
                      <Info className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
                      <span>
                        Listening cards export with Anki&apos;s{' '}
                        <code className="font-mono text-[var(--text)]">
                          {`{{tts ${(pack.ttsCode || 'ja-JP').replace(/-/g, '_')}:AudioText}}`}
                        </code>{' '}
                        template tag. Audio in Anki uses the device&apos;s installed TTS voices rather than bundled audio files.
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-4 rounded-2xl bg-[var(--surface-muted)]/70 border border-[var(--border)] space-y-4 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-bold text-[var(--text)]">CSV / TSV Options</span>
                    <button
                      type="button"
                      onClick={applyAnkiFriendlyCsvPreset}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs transition"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Use &ldquo;Anki-friendly import&rdquo; preset</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <label className="space-y-1">
                      <span className="font-semibold text-[var(--text-secondary)] block">
                        Delimiter
                      </span>
                      <select
                        value={csvDelimiter}
                        onChange={(e) => setCsvDelimiter(e.target.value as ',' | '\t')}
                        className="w-full min-h-[38px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                      >
                        <option value={'\t'}>Tab (.tsv)</option>
                        <option value={','}>Comma (.csv)</option>
                      </select>
                    </label>

                    <label className="inline-flex items-center gap-2 pt-5 cursor-pointer font-medium">
                      <input
                        type="checkbox"
                        checked={csvIncludeHeader}
                        onChange={(e) => setCsvIncludeHeader(e.target.checked)}
                        className="accent-indigo-600"
                      />
                      <span>Include header row</span>
                    </label>

                    <label className="inline-flex items-center gap-2 pt-5 cursor-pointer font-medium">
                      <input
                        type="checkbox"
                        checked={csvIncludeBom}
                        onChange={(e) => setCsvIncludeBom(e.target.checked)}
                        className="accent-indigo-600"
                      />
                      <span>UTF-8 with BOM</span>
                    </label>

                    <label className="inline-flex items-center gap-2 pt-5 cursor-pointer font-medium">
                      <input
                        type="checkbox"
                        checked={csvAllowHtml}
                        onChange={(e) => setCsvAllowHtml(e.target.checked)}
                        className="accent-indigo-600"
                      />
                      <span>Allow HTML (&lt;ruby&gt;)</span>
                    </label>
                  </div>

                  {/* Column Selector & Order */}
                  <div className="space-y-2">
                    <span className="font-semibold text-[var(--text-secondary)] block">
                      Columns &amp; order ({csvColumns.length} selected)
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {ALL_CSV_COLUMNS.map((col) => {
                        const active = csvColumns.includes(col);
                        return (
                          <button
                            key={col}
                            type="button"
                            onClick={() => toggleCsvColumn(col)}
                            className={`px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition ${
                              active
                                ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                            }`}
                          >
                            {CSV_COLUMN_LABELS[col]}
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {csvColumns.map((col, idx) => (
                        <div
                          key={col}
                          className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-[11px] font-mono"
                        >
                          <span className="text-[var(--text-muted)]">{idx + 1}.</span>
                          <span className="font-semibold text-[var(--text)]">
                            {CSV_COLUMN_LABELS[col]}
                          </span>
                          <button
                            type="button"
                            onClick={() => moveCsvColumn(idx, -1)}
                            disabled={idx === 0}
                            aria-label={`Move ${CSV_COLUMN_LABELS[col]} left`}
                            className="p-0.5 rounded hover:bg-[var(--surface-muted)] disabled:opacity-30"
                          >
                            <ArrowUp className="w-3 h-3 -rotate-90" />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveCsvColumn(idx, 1)}
                            disabled={idx === csvColumns.length - 1}
                            aria-label={`Move ${CSV_COLUMN_LABELS[col]} right`}
                            className="p-0.5 rounded hover:bg-[var(--surface-muted)] disabled:opacity-30"
                          >
                            <ArrowDown className="w-3 h-3 -rotate-90" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* Step 3: Preview & Generate */}
            <section
              aria-label="Preview and Generate Export"
              className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-4"
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <h2 className="font-bold text-sm text-[var(--text)]">
                    3. Preview &amp; Export
                  </h2>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--text-muted)] tabular-nums">
                    <span>
                      <strong className="text-[var(--text)]">{filteredCards.length.toLocaleString()}</strong>{' '}
                      {filteredCards.length === 1 ? 'card' : 'cards'}
                    </span>
                    <span>
                      <strong className="text-[var(--text)]">{exportPlanPreview.notes.length.toLocaleString()}</strong>{' '}
                      {exportPlanPreview.notes.length === 1 ? 'note' : 'notes'}
                    </span>
                    <span>
                      <strong className="text-[var(--text)]">{exportPlanPreview.decks.length}</strong>{' '}
                      {exportPlanPreview.decks.length === 1 ? 'deck' : 'decks'}
                    </span>
                    <span>
                      Templates:{' '}
                      <strong className="text-[var(--text)]">
                        {exportPlanPreview.presentCardTypes.length > 0
                          ? exportPlanPreview.presentCardTypes
                              .map((ct) => CARD_TYPE_LABELS[ct])
                              .join(', ')
                          : 'None'}
                      </strong>
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  {isExporting ? (
                    <button
                      type="button"
                      onClick={handleCancelExport}
                      className="min-h-[44px] px-4 py-2.5 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300 text-xs font-bold inline-flex items-center gap-1.5 hover:bg-rose-500/20 transition"
                    >
                      <X className="w-4 h-4" />
                      <span>Cancel Export</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleGenerateExport}
                      disabled={filteredCards.length === 0}
                      className="min-h-[44px] px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-xs font-bold inline-flex items-center gap-2 shadow-sm transition active:scale-95"
                    >
                      <Download className="w-4 h-4" />
                      <span>
                        {exportFormat === 'apkg'
                          ? `Export ${filteredCards.length.toLocaleString()} cards (.apkg)`
                          : `Export ${filteredCards.length.toLocaleString()} cards (${
                              csvDelimiter === '\t' ? '.tsv' : '.csv'
                            })`}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {/* Important New-Card & Deterministic GUID Notice */}
              <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)]/70 border border-[var(--border)] flex items-start gap-2.5 text-xs text-[var(--text-secondary)]">
                <Info className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
                <div className="space-y-1 leading-relaxed">
                  <p>
                    <strong className="text-[var(--text)]">Exported as New cards:</strong> All cards enter Anki in the <em>New</em> queue with empty review history so Anki schedules them cleanly from scratch.
                  </p>
                  <p>
                    <strong className="text-[var(--text)]">Safe re-export updates:</strong> Notes use deterministic GUIDs and fixed note type IDs (<code className="font-mono">LinguaForge Vocabulary</code> and <code className="font-mono">LinguaForge Cloze</code>), so re-importing updated cards in Anki updates existing notes instead of duplicating them.
                  </p>
                </div>
              </div>

              {/* Progress Bar */}
              {isExporting && exportProgress && (
                <div className="p-4 rounded-2xl bg-[var(--accent-subtle)] border border-indigo-500/30 space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-[var(--accent-text)]">
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>{phaseLabel}</span>
                    </span>
                    <span className="tabular-nums font-mono">{exportProgress.percent}%</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-[var(--surface)] overflow-hidden">
                    <div
                      className="h-full bg-indigo-600 transition-all duration-150"
                      style={{ width: `${exportProgress.percent}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Error State */}
              {exportError && (
                <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 flex items-start gap-2.5 text-xs text-rose-800 dark:text-rose-200">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
                  <div className="space-y-1">
                    <div className="font-bold">Export failed — no file was downloaded</div>
                    <div>{exportError}</div>
                  </div>
                </div>
              )}

              {/* Verified Artifact & Download Summary */}
              {readyArtifact && (
                <div className="p-4 rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-500/40 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-start gap-2.5">
                      <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                      <div className="space-y-0.5 text-xs">
                        <div className="font-bold text-emerald-900 dark:text-emerald-200">
                          Ready: {readyArtifact.fileName} (
                          {(readyArtifact.byteSize / 1024).toFixed(1)} KB)
                        </div>
                        <div className="text-emerald-800/80 dark:text-emerald-300/80 tabular-nums">
                          {readyArtifact.cardCount} cards · {readyArtifact.noteCount} notes ·{' '}
                          {readyArtifact.deckNames.length}{' '}
                          {readyArtifact.deckNames.length === 1 ? 'deck' : 'decks'}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => triggerDownloadAndRecord(readyArtifact)}
                      className="min-h-[40px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold inline-flex items-center gap-1.5 shrink-0 transition"
                    >
                      <Download className="w-4 h-4" />
                      <span>Download {readyArtifact.fileName}</span>
                    </button>
                  </div>

                  {readyArtifact.verification && (
                    <div className="p-3 rounded-xl bg-[var(--surface)] border border-emerald-500/30 text-[11px] space-y-2">
                      <div className="flex items-center gap-1.5 font-bold text-emerald-700 dark:text-emerald-300">
                        <ShieldCheck className="w-4 h-4" />
                        <span>
                          Self-check passed: SQLite schema v{readyArtifact.verification.schemaVersion} · Entries [{readyArtifact.verification.zipEntries.join(', ')}] · revlog={readyArtifact.verification.revlogCount}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[var(--text-secondary)]">
                        {readyArtifact.verification.firstNote && (
                          <div className="p-2 rounded-lg bg-[var(--surface-muted)]">
                            <div className="text-[10px] uppercase text-[var(--text-muted)] font-sans font-bold">
                              First Note Decoded
                            </div>
                            <div className="truncate">
                              {readyArtifact.verification.firstNote.word} —{' '}
                              {readyArtifact.verification.firstNote.meaning}
                            </div>
                            <div className="text-[10px] text-[var(--text-muted)]">
                              guid: {readyArtifact.verification.firstNote.guid} · csum:{' '}
                              {readyArtifact.verification.firstNote.csum}
                            </div>
                          </div>
                        )}
                        {readyArtifact.verification.lastNote && (
                          <div className="p-2 rounded-lg bg-[var(--surface-muted)]">
                            <div className="text-[10px] uppercase text-[var(--text-muted)] font-sans font-bold">
                              Last Note Decoded
                            </div>
                            <div className="truncate">
                              {readyArtifact.verification.lastNote.word} —{' '}
                              {readyArtifact.verification.lastNote.meaning}
                            </div>
                            <div className="text-[10px] text-[var(--text-muted)]">
                              guid: {readyArtifact.verification.lastNote.guid} · csum:{' '}
                              {readyArtifact.verification.lastNote.csum}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* First 10 Rows Preview Table */}
              {filteredCards.length === 0 ? (
                <div className="p-8 rounded-2xl bg-[var(--surface-muted)]/60 border border-[var(--border)] text-center text-xs text-[var(--text-muted)]">
                  No cards match the current filter selection. Adjust your filters above to preview cards.
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-[var(--text-muted)]">
                    Preview (first {previewRows.length} of {filteredCards.length.toLocaleString()} cards)
                  </div>
                  <div className="overflow-x-auto rounded-2xl border border-[var(--border)]">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                          <th className="py-2.5 px-3 font-semibold">Word</th>
                          <th className="py-2.5 px-3 font-semibold">Reading</th>
                          <th className="py-2.5 px-3 font-semibold">Meaning</th>
                          <th className="py-2.5 px-3 font-semibold">Type</th>
                          <th className="py-2.5 px-3 font-semibold">Deck</th>
                          <th className="py-2.5 px-3 font-semibold">Level</th>
                          <th className="py-2.5 px-3 font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {previewRows.map((c) => {
                          const deckLabel = deckNameMap.get(c.deckId) || 'Default';
                          return (
                            <tr key={c.id} className="hover:bg-[var(--surface-muted)]/40">
                              <td className="py-2.5 px-3 font-bold text-[var(--text)] whitespace-nowrap">
                                <FuriganaText
                                  text={c.word}
                                  reading={c.reading}
                                  segments={c.furiganaSegments}
                                  furiganaMode={furiganaMode}
                                />
                              </td>
                              <td className="py-2.5 px-3 text-[var(--text-secondary)] whitespace-nowrap">
                                {c.reading || '—'}
                              </td>
                              <td className="py-2.5 px-3 text-[var(--text)] max-w-[260px] truncate">
                                {c.meaning}
                              </td>
                              <td className="py-2.5 px-3 text-[var(--text-muted)] whitespace-nowrap">
                                {CARD_TYPE_LABELS[c.cardType]}
                              </td>
                              <td className="py-2.5 px-3 text-[var(--text-secondary)] whitespace-nowrap">
                                {deckLabel}
                              </td>
                              <td className="py-2.5 px-3 whitespace-nowrap">
                                {c.level ? (
                                  <span className="px-1.5 py-0.5 rounded bg-[var(--accent-subtle)] text-[var(--accent-text)] font-semibold text-[11px]">
                                    {c.level}
                                  </span>
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td className="py-2.5 px-3 whitespace-nowrap text-[11px]">
                                {c.exportedAt ? (
                                  <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                                    Exported {new Date(c.exportedAt).toLocaleDateString()}
                                  </span>
                                ) : (
                                  <span className="text-[var(--text-muted)]">Not exported</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          </>
        )}

        {/* Export History & Anki Import Guide */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Export History */}
          <section
            aria-label="Export History"
            className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-bold text-sm text-[var(--text)] flex items-center gap-2">
                <History className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <span>Export History</span>
              </h2>
              {exportHistory.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearExportHistory}
                  className="text-xs font-semibold text-[var(--text-muted)] hover:text-rose-600 inline-flex items-center gap-1 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear</span>
                </button>
              )}
            </div>

            {exportHistory.length === 0 ? (
              <div className="p-6 rounded-2xl bg-[var(--surface-muted)]/60 border border-[var(--border)] text-center text-xs text-[var(--text-muted)]">
                No exports recorded yet. Generated `.apkg`, `.csv`, and `.tsv` exports will appear here.
              </div>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {exportHistory.map((item) => (
                  <div
                    key={item.id}
                    className="p-3 rounded-2xl bg-[var(--surface-muted)]/70 border border-[var(--border)] flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="font-bold text-[var(--text)] truncate">
                        {item.fileName}
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)] truncate">
                        {new Date(item.exportedAt).toLocaleString()} ·{' '}
                        {item.deckNames.join(', ')}
                      </div>
                    </div>
                    <div className="text-right shrink-0 space-y-0.5 tabular-nums">
                      <span className="inline-block px-2 py-0.5 rounded bg-[var(--accent-subtle)] text-[var(--accent-text)] font-mono font-bold uppercase text-[10px]">
                        .{item.format}
                      </span>
                      <div className="text-[11px] text-[var(--text-secondary)] font-semibold">
                        {item.cardCount} cards / {item.noteCount} notes
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Anki Import Guide */}
          <section
            aria-label="Anki Import Guide"
            className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-4"
          >
            <h2 className="font-bold text-sm text-[var(--text)] flex items-center gap-2">
              <HelpCircle className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>Anki Import Guide</span>
            </h2>

            <div className="space-y-3 text-xs text-[var(--text-secondary)] leading-relaxed">
              <div className="p-3 rounded-2xl bg-[var(--surface-muted)]/60 border border-[var(--border)] space-y-1">
                <div className="font-bold text-[var(--text)]">Anki Desktop (Windows / macOS / Linux)</div>
                <p>
                  Open Anki and choose <strong>File → Import…</strong>, then select the downloaded <code className="font-mono">.apkg</code> file. Your decks, card templates, furigana, and tags import automatically.
                </p>
              </div>

              <div className="p-3 rounded-2xl bg-[var(--surface-muted)]/60 border border-[var(--border)] space-y-1">
                <div className="font-bold text-[var(--text)]">AnkiDroid (Android)</div>
                <p>
                  Tap the <strong>⋮ menu → Import</strong> (or open the <code className="font-mono">.apkg</code> file directly from your Files / Downloads app and pick AnkiDroid).
                </p>
              </div>

              <div className="p-3 rounded-2xl bg-[var(--surface-muted)]/60 border border-[var(--border)] space-y-1">
                <div className="font-bold text-[var(--text)]">Updating existing cards without duplicates</div>
                <p>
                  Each exported note keeps the same deterministic <code className="font-mono">guid</code> and uses the fixed <code className="font-mono">LinguaForge Vocabulary</code> note type. When you re-export edited cards and re-import the <code className="font-mono">.apkg</code>, Anki updates matching notes in place. For <code className="font-mono">.tsv</code> imports, enable <strong>Allow HTML in fields</strong> and select <strong>Update existing notes when first field matches</strong>.
                </p>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
};
