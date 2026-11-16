import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { db, type CardType, type DeckItem } from '../../db/db';
import { ensureDefaultDeck } from '../../db/cards';
import {
  buildFailedRowsCsv,
  computeLayoutSignature,
  decodeUploadedTextBuffer,
  detectCsvDelimiter,
  detectDefaultColumnMapping,
  detectHasHeaderRow,
  IMPORT_CARD_FIELD_OPTIONS,
  loadSavedColumnMappings,
  parseDelimitedText,
  parseInlineFurigana,
  runCardCsvImport,
  saveColumnMappingForLayout,
  type CardCsvImportProgress,
  type CardCsvImportResult,
  type CsvDelimiter,
  type DuplicateImportMode,
  type ImportCardField,
} from '../../core/cardCsvImport';
import { useAppStore } from '../../store/useAppStore';
import { getLanguagePack } from '../../packs/registry';
import { ApkgImportSection } from './ApkgImportSection';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Download,
  FileArchive,
  FileSpreadsheet,
  FolderPlus,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';

const DELIMITER_LABELS: Record<CsvDelimiter, string> = {
  ',': 'Comma (,)',
  '\t': 'Tab (\\t)',
  ';': 'Semicolon (;)',
  '|': 'Pipe (|)',
};

const CARD_TYPE_OPTIONS: { value: CardType; label: string }[] = [
  { value: 'word_to_meaning', label: 'Word → Meaning' },
  { value: 'meaning_to_word', label: 'Meaning → Word' },
  { value: 'reading', label: 'Reading' },
];

export const ImportCardsView: React.FC = () => {
  const { activeLanguageId } = useAppStore();
  const pack = getLanguagePack(activeLanguageId);

  const [importMode, setImportMode] = useState<'csv' | 'apkg'>('csv');
  const [decks, setDecks] = useState<DeckItem[]>([]);
  const [isLoadingDecks, setIsLoadingDecks] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Uploaded File State
  const [fileName, setFileName] = useState<string>('');
  const [rawText, setRawText] = useState<string>('');
  const [encodingLabel, setEncodingLabel] = useState<string>('');
  const [delimiter, setDelimiter] = useState<CsvDelimiter>(',');
  const [detectedDelimiter, setDetectedDelimiter] = useState<CsvDelimiter>(',');
  const [hasHeaderRow, setHasHeaderRow] = useState<boolean>(true);
  const [mapping, setMapping] = useState<ImportCardField[]>([]);
  const [rememberedLayoutApplied, setRememberedLayoutApplied] = useState<boolean>(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // Import Options
  const [targetDeckChoice, setTargetDeckChoice] = useState<string>('');
  const [newDeckName, setNewDeckName] = useState<string>('');
  const [cardType, setCardType] = useState<CardType>('word_to_meaning');
  const [duplicateMode, setDuplicateMode] = useState<DuplicateImportMode>('skip');

  // Execution State
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<CardCsvImportProgress | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<CardCsvImportResult | null>(null);

  const cancelledRef = useRef<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadDecks = useCallback(async () => {
    setIsLoadingDecks(true);
    setLoadError(null);
    try {
      const defDeck = await ensureDefaultDeck(activeLanguageId);
      const list = await db.decks.where('languageId').equals(activeLanguageId).toArray();
      list.sort((a, b) => a.createdAt - b.createdAt);
      setDecks(list);
      setTargetDeckChoice((prev) =>
        prev === '__new__' || list.some((d) => d.id === prev) ? prev : defDeck.id
      );
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load decks.');
    } finally {
      setIsLoadingDecks(false);
    }
  }, [activeLanguageId]);

  useEffect(() => {
    loadDecks();
  }, [loadDecks]);

  const parsedRows = useMemo(() => {
    if (!rawText) return [];
    return parseDelimitedText(rawText, delimiter);
  }, [rawText, delimiter]);

  const maxColumns = useMemo(() => {
    if (parsedRows.length === 0) return 0;
    return parsedRows.slice(0, 20).reduce((max, r) => Math.max(max, r.length), 0);
  }, [parsedRows]);

  const headers = useMemo(() => {
    if (maxColumns === 0) return [];
    if (hasHeaderRow && parsedRows[0]) {
      return Array.from({ length: maxColumns }, (_, i) => parsedRows[0][i] || `Column ${i + 1}`);
    }
    return Array.from({ length: maxColumns }, (_, i) => `Column ${i + 1}`);
  }, [hasHeaderRow, parsedRows, maxColumns]);

  const dataRows = useMemo(() => {
    return hasHeaderRow ? parsedRows.slice(1) : parsedRows;
  }, [parsedRows, hasHeaderRow]);

  const previewRows = useMemo(() => dataRows.slice(0, 5), [dataRows]);

  const layoutKey = useMemo(() => {
    if (maxColumns === 0) return '';
    return computeLayoutSignature(headers, hasHeaderRow, maxColumns, delimiter);
  }, [headers, hasHeaderRow, maxColumns, delimiter]);

  const resolveMappingForParsed = useCallback(
    async (
      nextText: string,
      nextDelim: CsvDelimiter,
      nextHeaderFlag?: boolean
    ) => {
      const rows = parseDelimitedText(nextText, nextDelim);
      if (rows.length === 0) {
        setMapping([]);
        setRememberedLayoutApplied(false);
        return;
      }
      const cols = rows.slice(0, 20).reduce((m, r) => Math.max(m, r.length), 0);
      const useHeader =
        nextHeaderFlag !== undefined ? nextHeaderFlag : detectHasHeaderRow(rows[0] || []);
      setHasHeaderRow(useHeader);

      const hdrs = useHeader
        ? Array.from({ length: cols }, (_, i) => rows[0][i] || `Column ${i + 1}`)
        : Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);

      const sig = computeLayoutSignature(hdrs, useHeader, cols, nextDelim);
      const savedMap = await loadSavedColumnMappings();
      const saved = savedMap[sig];

      if (saved && Array.isArray(saved.mapping) && saved.mapping.length === cols) {
        setMapping(saved.mapping);
        setRememberedLayoutApplied(true);
      } else {
        setMapping(detectDefaultColumnMapping(hdrs, useHeader, cols));
        setRememberedLayoutApplied(false);
      }
    },
    []
  );

  const processSelectedFile = useCallback(
    async (file: File) => {
      setFileError(null);
      setImportError(null);
      setImportResult(null);

      try {
        const buffer = await file.arrayBuffer();
        const decoded = decodeUploadedTextBuffer(buffer);
        if (!decoded.text.trim()) {
          setFileError('The selected file is empty.');
          setFileName(file.name);
          setRawText('');
          setMapping([]);
          return;
        }

        const delim = detectCsvDelimiter(decoded.text, file.name);
        const testRows = parseDelimitedText(decoded.text, delim);
        if (testRows.length === 0) {
          setFileError('No rows could be parsed from this file.');
          setFileName(file.name);
          setRawText('');
          setMapping([]);
          return;
        }

        setFileName(file.name);
        setEncodingLabel(decoded.encodingLabel);
        setDetectedDelimiter(delim);
        setDelimiter(delim);
        setRawText(decoded.text);

        await resolveMappingForParsed(decoded.text, delim);
      } catch (err: any) {
        setFileError(err?.message || 'Failed to read the selected file.');
      }
    },
    [resolveMappingForParsed]
  );

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processSelectedFile(file);
  };

  const handleDelimiterChange = async (nextDelim: CsvDelimiter) => {
    setDelimiter(nextDelim);
    setImportResult(null);
    if (rawText) {
      await resolveMappingForParsed(rawText, nextDelim, hasHeaderRow);
    }
  };

  const handleHeaderToggle = async (nextHasHeader: boolean) => {
    setHasHeaderRow(nextHasHeader);
    setImportResult(null);
    if (rawText) {
      await resolveMappingForParsed(rawText, delimiter, nextHasHeader);
    }
  };

  const handleMappingChange = async (colIndex: number, nextField: ImportCardField) => {
    const next = [...mapping];
    while (next.length < maxColumns) next.push('ignore');
    next[colIndex] = nextField;
    setMapping(next);
    setRememberedLayoutApplied(false);

    if (layoutKey) {
      await saveColumnMappingForLayout({
        layoutKey,
        mapping: next,
        hasHeaderRow,
        delimiter,
        updatedAt: Date.now(),
      });
    }
  };

  const handleResetAutoMapping = async () => {
    const auto = detectDefaultColumnMapping(headers, hasHeaderRow, maxColumns);
    setMapping(auto);
    setRememberedLayoutApplied(false);
    if (layoutKey) {
      await saveColumnMappingForLayout({
        layoutKey,
        mapping: auto,
        hasHeaderRow,
        delimiter,
        updatedAt: Date.now(),
      });
    }
  };

  const wordMapped = mapping.includes('word');

  const handleStartImport = async () => {
    if (isImporting || dataRows.length === 0) return;
    setImportError(null);
    setImportResult(null);

    if (!wordMapped) {
      setImportError('Please map at least one column to "Word" before importing.');
      return;
    }

    if (targetDeckChoice === '__new__' && !newDeckName.trim()) {
      setImportError('Please enter a name for the new target deck.');
      return;
    }

    // Persist the current layout mapping before running import
    if (layoutKey) {
      await saveColumnMappingForLayout({
        layoutKey,
        mapping,
        hasHeaderRow,
        delimiter,
        updatedAt: Date.now(),
      });
    }

    cancelledRef.current = false;
    setIsImporting(true);
    setProgress({ processed: 0, total: dataRows.length, percent: 0 });

    try {
      const res = await runCardCsvImport(
        parsedRows,
        {
          languageId: activeLanguageId,
          mapping,
          hasHeaderRow,
          targetDeckId: targetDeckChoice === '__new__' ? undefined : targetDeckChoice,
          newDeckName: targetDeckChoice === '__new__' ? newDeckName.trim() : undefined,
          cardType,
          duplicateMode,
          batchSize: 35,
        },
        {
          tokenizeFn: (text: string) => pack.tokenize(text),
          onProgress: (p) => setProgress(p),
          isCancelled: () => cancelledRef.current,
        }
      );

      setImportResult(res);
      await loadDecks();
      if (targetDeckChoice === '__new__' && res.createdDeckNames.length > 0) {
        setNewDeckName('');
      }
    } catch (err: any) {
      setImportError(err?.message || 'Import failed unexpectedly.');
    } finally {
      setIsImporting(false);
    }
  };

  const handleCancelImport = () => {
    cancelledRef.current = true;
  };

  const handleDownloadFailedRows = () => {
    if (!importResult || importResult.failedRows.length === 0) return;
    const { fileName: errFileName, bytes } = buildFailedRowsCsv(
      importResult.failedRows,
      hasHeaderRow ? headers : undefined
    );
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = errFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const activeMappedPreviewColumns = useMemo(() => {
    const cols: { index: number; field: Exclude<ImportCardField, 'ignore'>; label: string }[] = [];
    for (let i = 0; i < mapping.length; i++) {
      const f = mapping[i];
      if (f && f !== 'ignore') {
        const opt = IMPORT_CARD_FIELD_OPTIONS.find((o) => o.value === f);
        cols.push({ index: i, field: f, label: opt?.label.replace(' (required)', '') || f });
      }
    }
    return cols;
  }, [mapping]);

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text)] pb-16">
      {/* Header */}
      <header className="bg-[var(--surface)] border-b border-[var(--border)] px-4 sm:px-6 py-5">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <Link
              to="/cards"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text)] transition"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back to Cards</span>
            </Link>
            <h1 className="text-2xl font-black tracking-tight flex items-center gap-2 text-[var(--text)]">
              {importMode === 'apkg' ? (
                <FileArchive className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
              ) : (
                <FileSpreadsheet className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
              )}
              <span>
                {importMode === 'apkg'
                  ? 'Import Cards from Anki (.apkg)'
                  : 'Import Cards from CSV / TSV'}
              </span>
            </h1>
            <p className="text-xs text-[var(--text-muted)]">
              {pack.flagEmoji} {pack.name} ·{' '}
              {importMode === 'apkg'
                ? 'Unpacks .apkg decks, note types, furigana, and tags completely offline'
                : 'Imports CSV, TSV, or TXT files completely offline and generates furigana automatically'}
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-6xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {/* Source Format Switcher */}
        <div
          role="tablist"
          aria-label="Import format"
          className="inline-flex flex-wrap items-center gap-1 p-1.5 rounded-2xl bg-[var(--surface)] border border-[var(--border)]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={importMode === 'csv'}
            onClick={() => setImportMode('csv')}
            className={`min-h-[40px] px-4 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-2 transition whitespace-nowrap ${
              importMode === 'csv'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-muted)]'
            }`}
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span>CSV / TSV / TXT</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={importMode === 'apkg'}
            onClick={() => setImportMode('apkg')}
            className={`min-h-[40px] px-4 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-2 transition whitespace-nowrap ${
              importMode === 'apkg'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-muted)]'
            }`}
          >
            <FileArchive className="w-4 h-4" />
            <span>Anki package (.apkg)</span>
          </button>
        </div>

        {loadError && (
          <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 flex items-center justify-between gap-3 text-xs text-rose-800 dark:text-rose-200">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <span>{loadError}</span>
            </div>
            <button
              type="button"
              onClick={loadDecks}
              className="px-3 py-1.5 rounded-lg bg-rose-600 text-white font-semibold hover:bg-rose-700 transition"
            >
              Retry
            </button>
          </div>
        )}

        {importMode === 'apkg' ? (
          <ApkgImportSection
            decks={decks}
            isLoadingDecks={isLoadingDecks}
            onDecksChanged={loadDecks}
          />
        ) : (
          <>
            {/* Step 1: Choose File */}
            <section
              aria-label="Choose File"
              className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-4"
            >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-bold text-sm text-[var(--text)]">
              1. Choose CSV, TSV, or TXT file
            </h2>
            {fileName && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)] tabular-nums">
                <span className="font-semibold text-[var(--text)]">{fileName}</span>
                <span aria-hidden="true">·</span>
                <span>Encoding: {encodingLabel}</span>
                <span aria-hidden="true">·</span>
                <span>{dataRows.length.toLocaleString()} data rows</span>
              </div>
            )}
          </div>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              e.preventDefault();
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) await processSelectedFile(dropped);
            }}
            className="p-6 rounded-2xl border-2 border-dashed border-[var(--border)] bg-[var(--surface-muted)]/50 flex flex-col sm:flex-row items-center justify-between gap-4"
          >
            <div className="space-y-1 text-center sm:text-left">
              <div className="text-sm font-bold text-[var(--text)]">
                Drop a file here or browse from your device
              </div>
              <p className="text-xs text-[var(--text-muted)]">
                Accepts CSV, TSV, TXT, or Anki plain-text exports (UTF-8 with or without BOM). Delimiter and columns are auto-detected.
              </p>
            </div>

            <div className="shrink-0">
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFileChange}
                className="hidden"
                aria-label="Choose CSV, TSV or TXT file"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="min-h-[44px] px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold inline-flex items-center gap-2 transition whitespace-nowrap"
              >
                <Upload className="w-4 h-4" />
                <span>{fileName ? 'Choose another file' : 'Select File'}</span>
              </button>
            </div>
          </div>

          {fileError && (
            <div className="p-3.5 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 flex items-center gap-2 text-xs text-rose-800 dark:text-rose-200">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <span>{fileError}</span>
            </div>
          )}

          {rawText && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-2 border-t border-[var(--border)] text-xs">
              <label className="space-y-1">
                <span className="font-semibold text-[var(--text-secondary)] block">
                  Delimiter (detected: {DELIMITER_LABELS[detectedDelimiter]})
                </span>
                <select
                  value={delimiter}
                  onChange={(e) => handleDelimiterChange(e.target.value as CsvDelimiter)}
                  className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] font-medium"
                >
                  <option value=",">Comma (,)</option>
                  <option value={'\t'}>Tab (\t)</option>
                  <option value=";">Semicolon (;)</option>
                  <option value="|">Pipe (|)</option>
                </select>
              </label>

              <div className="flex items-end pb-2">
                <label className="inline-flex items-center gap-2 cursor-pointer font-medium text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={hasHeaderRow}
                    onChange={(e) => handleHeaderToggle(e.target.checked)}
                    className="w-4 h-4 accent-indigo-600 rounded"
                  />
                  <span>First row contains column headers</span>
                </label>
              </div>
            </div>
          )}
        </section>

        {/* Step 2: Column Mapping & 5-Row Preview */}
        {parsedRows.length > 0 && (
          <section
            aria-label="Column Mapping and Preview"
            className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-0.5">
                <h2 className="font-bold text-sm text-[var(--text)]">
                  2. Map columns &amp; preview (first 5 rows)
                </h2>
                <p className="text-xs text-[var(--text-muted)]">
                  {rememberedLayoutApplied
                    ? 'Restored your saved column mapping for this file layout.'
                    : 'Your column mapping is automatically remembered for future files with this layout.'}
                </p>
              </div>

              <button
                type="button"
                onClick={handleResetAutoMapping}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] transition"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset auto-detect</span>
              </button>
            </div>

            {!wordMapped && (
              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300/70 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>Map at least one column to <strong>Word</strong> to continue.</span>
              </div>
            )}

            {/* Column Mapping Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 text-xs">
              {headers.map((hdr, colIdx) => {
                const sample = dataRows[0]?.[colIdx] || '';
                const currentField = mapping[colIdx] || 'ignore';
                return (
                  <div
                    key={colIdx}
                    className={`p-3 rounded-2xl border space-y-2 ${
                      currentField !== 'ignore'
                        ? 'border-indigo-500/60 bg-[var(--accent-subtle)]/40'
                        : 'border-[var(--border)] bg-[var(--surface-muted)]/50'
                    }`}
                  >
                    <div className="space-y-0.5">
                      <div className="font-bold text-[var(--text)] truncate" title={hdr}>
                        {hdr}
                      </div>
                      <div
                        className="text-[11px] text-[var(--text-muted)] truncate"
                        title={sample}
                      >
                        Sample: {sample || '—'}
                      </div>
                    </div>

                    <select
                      value={currentField}
                      onChange={(e) =>
                        handleMappingChange(colIdx, e.target.value as ImportCardField)
                      }
                      aria-label={`Map column ${hdr}`}
                      className="w-full min-h-[38px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] font-semibold"
                    >
                      {IMPORT_CARD_FIELD_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>

            {/* 5-Row Preview Table */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-[var(--text-muted)] tabular-nums">
                Preview (showing {previewRows.length} of {dataRows.length.toLocaleString()} rows)
              </div>

              {activeMappedPreviewColumns.length === 0 ? (
                <div className="p-6 rounded-2xl bg-[var(--surface-muted)]/60 border border-[var(--border)] text-center text-xs text-[var(--text-muted)]">
                  All columns are currently set to Skip / Ignore. Map at least the Word column above to preview rows.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-2xl border border-[var(--border)]">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                        <th className="py-2.5 px-3 font-semibold tabular-nums">Row</th>
                        {activeMappedPreviewColumns.map((col) => (
                          <th key={`${col.index}-${col.field}`} className="py-2.5 px-3 font-semibold whitespace-nowrap">
                            {col.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {previewRows.map((row, idx) => (
                        <tr key={idx} className="hover:bg-[var(--surface-muted)]/40">
                          <td className="py-2.5 px-3 text-[var(--text-muted)] font-mono tabular-nums">
                            {(hasHeaderRow ? idx + 2 : idx + 1)}
                          </td>
                          {activeMappedPreviewColumns.map((col) => {
                            const rawCell = row[col.index] || '';
                            const display =
                              col.field === 'word'
                                ? parseInlineFurigana(rawCell).plainText || rawCell
                                : rawCell;
                            return (
                              <td
                                key={`${col.index}-${col.field}`}
                                className="py-2.5 px-3 text-[var(--text)] max-w-[220px] truncate"
                                title={display}
                              >
                                {display || '—'}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Step 3: Import Options & Run */}
        {parsedRows.length > 0 && (
          <section
            aria-label="Import Options"
            className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-5"
          >
            <h2 className="font-bold text-sm text-[var(--text)]">
              3. Import options
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              {/* Target Deck */}
              <div className="space-y-2">
                <label className="font-semibold text-[var(--text-secondary)] block">
                  Target deck
                </label>
                <select
                  value={targetDeckChoice}
                  onChange={(e) => setTargetDeckChoice(e.target.value)}
                  disabled={isLoadingDecks || isImporting}
                  className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] font-medium"
                >
                  {decks.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                  <option value="__new__">+ Create new deck...</option>
                </select>

                {targetDeckChoice === '__new__' && (
                  <div className="flex items-center gap-2 pt-1">
                    <FolderPlus className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                    <input
                      type="text"
                      value={newDeckName}
                      onChange={(e) => setNewDeckName(e.target.value)}
                      placeholder="New deck name (e.g. JLPT N4 Core)"
                      disabled={isImporting}
                      className="flex-1 min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
                    />
                  </div>
                )}

                {mapping.includes('deck') && (
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Rows with a non-empty mapped Deck column will be placed in that deck (creating it if needed). Empty Deck cells use this target deck.
                  </p>
                )}
              </div>

              {/* Card Type */}
              <div className="space-y-2">
                <label className="font-semibold text-[var(--text-secondary)] block">
                  Card type to create
                </label>
                <select
                  value={cardType}
                  onChange={(e) => setCardType(e.target.value as CardType)}
                  disabled={isImporting}
                  className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] font-medium"
                >
                  {CARD_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Words without explicit furigana automatically get furigana generated via the offline tokenizer when a reading is available.
                </p>
              </div>
            </div>

            {/* Duplicate Handling */}
            <div className="space-y-2 pt-2 border-t border-[var(--border)] text-xs">
              <span className="font-semibold text-[var(--text-secondary)] block">
                Duplicate handling (matched by lemma + reading + card type)
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => setDuplicateMode('skip')}
                  className={`p-3 rounded-2xl border text-left transition ${
                    duplicateMode === 'skip'
                      ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                      : 'border-[var(--border)] bg-[var(--surface-muted)]/60 text-[var(--text)]'
                  }`}
                >
                  <div className="font-bold">Skip duplicates</div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                    Keep existing cards untouched and count matches as skipped.
                  </div>
                </button>

                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => setDuplicateMode('update')}
                  className={`p-3 rounded-2xl border text-left transition ${
                    duplicateMode === 'update'
                      ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                      : 'border-[var(--border)] bg-[var(--surface-muted)]/60 text-[var(--text)]'
                  }`}
                >
                  <div className="font-bold">Update existing cards instead</div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                    Update meaning, sentence, tags, notes, and furigana while keeping review progress.
                  </div>
                </button>

                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => setDuplicateMode('allow')}
                  className={`p-3 rounded-2xl border text-left transition ${
                    duplicateMode === 'allow'
                      ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                      : 'border-[var(--border)] bg-[var(--surface-muted)]/60 text-[var(--text)]'
                  }`}
                >
                  <div className="font-bold">Allow duplicates</div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                    Create a new card for every valid row even if a match exists.
                  </div>
                </button>
              </div>
            </div>

            {/* Action / Progress */}
            <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-[var(--text-muted)] tabular-nums">
                Ready to process <strong>{dataRows.length.toLocaleString()}</strong> rows in batches
              </div>

              {isImporting ? (
                <button
                  type="button"
                  onClick={handleCancelImport}
                  className="min-h-[44px] px-4 py-2.5 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300 text-xs font-bold inline-flex items-center gap-1.5 hover:bg-rose-500/20 transition"
                >
                  <X className="w-4 h-4" />
                  <span>Cancel Import</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStartImport}
                  disabled={!wordMapped || dataRows.length === 0}
                  className="min-h-[44px] px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-xs font-bold inline-flex items-center gap-2 shadow-sm transition active:scale-95"
                >
                  <Upload className="w-4 h-4" />
                  <span>Import {dataRows.length.toLocaleString()} rows</span>
                </button>
              )}
            </div>

            {isImporting && progress && (
              <div className="p-4 rounded-2xl bg-[var(--accent-subtle)] border border-indigo-500/30 space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold text-[var(--accent-text)]">
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>
                      Importing rows ({progress.processed.toLocaleString()} / {progress.total.toLocaleString()})...
                    </span>
                  </span>
                  <span className="tabular-nums font-mono">{progress.percent}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-[var(--surface)] overflow-hidden">
                  <div
                    className="h-full bg-indigo-600 transition-all duration-150"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
              </div>
            )}

            {importError && (
              <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 flex items-start gap-2.5 text-xs text-rose-800 dark:text-rose-200">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
                <div>
                  <div className="font-bold">Import error</div>
                  <div>{importError}</div>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Import Summary */}
        {importResult && (
          <section
            aria-label="Import Summary"
            className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-4"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                {importResult.cancelled ? (
                  <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                )}
                <div>
                  <h2 className="font-bold text-sm text-[var(--text)]">
                    {importResult.cancelled ? 'Import cancelled' : 'Import complete'}
                  </h2>
                  {importResult.createdDeckNames.length > 0 && (
                    <p className="text-xs text-[var(--text-muted)]">
                      Created decks: {importResult.createdDeckNames.join(', ')}
                    </p>
                  )}
                </div>
              </div>

              <Link
                to="/cards"
                className="min-h-[40px] px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold inline-flex items-center justify-center transition"
              >
                View Cards
              </Link>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs tabular-nums">
              <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
                <div className="text-[11px] text-[var(--text-muted)]">Rows read</div>
                <div className="text-lg font-black text-[var(--text)] mt-0.5">
                  {importResult.rowsRead.toLocaleString()}
                </div>
              </div>
              <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
                <div className="text-[11px] text-[var(--text-muted)]">Cards created</div>
                <div className="text-lg font-black text-emerald-600 dark:text-emerald-400 mt-0.5">
                  {importResult.cardsCreated.toLocaleString()}
                </div>
              </div>
              <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
                <div className="text-[11px] text-[var(--text-muted)]">Cards updated</div>
                <div className="text-lg font-black text-indigo-600 dark:text-indigo-400 mt-0.5">
                  {importResult.cardsUpdated.toLocaleString()}
                </div>
              </div>
              <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
                <div className="text-[11px] text-[var(--text-muted)]">Skipped duplicates</div>
                <div className="text-lg font-black text-[var(--text)] mt-0.5">
                  {importResult.skippedDuplicates.toLocaleString()}
                </div>
              </div>
              <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
                <div className="text-[11px] text-[var(--text-muted)]">Errors</div>
                <div
                  className={`text-lg font-black mt-0.5 ${
                    importResult.failedRows.length > 0
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-[var(--text)]'
                  }`}
                >
                  {importResult.failedRows.length.toLocaleString()}
                </div>
              </div>
            </div>

            {importResult.failedRows.length > 0 && (
              <div className="space-y-3 pt-2 border-t border-[var(--border)]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-bold text-rose-700 dark:text-rose-300">
                    Failed rows ({importResult.failedRows.length.toLocaleString()})
                  </div>
                  <button
                    type="button"
                    onClick={handleDownloadFailedRows}
                    className="min-h-[38px] px-3.5 py-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 text-rose-700 dark:text-rose-300 text-xs font-bold inline-flex items-center gap-1.5 transition"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download failed rows (.csv)</span>
                  </button>
                </div>

                <div className="overflow-x-auto max-h-60 rounded-2xl border border-[var(--border)]">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                        <th className="py-2 px-3 font-semibold tabular-nums">Row #</th>
                        <th className="py-2 px-3 font-semibold">Word</th>
                        <th className="py-2 px-3 font-semibold">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {importResult.failedRows.slice(0, 50).map((f) => (
                        <tr key={`${f.rowNumber}-${f.reason}`}>
                          <td className="py-2 px-3 font-mono tabular-nums text-[var(--text-muted)]">
                            {f.rowNumber}
                          </td>
                          <td className="py-2 px-3 font-semibold text-[var(--text)]">
                            {f.word || '—'}
                          </td>
                          <td className="py-2 px-3 text-rose-700 dark:text-rose-300">
                            {f.reason}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}
          </>
        )}
      </main>
    </div>
  );
};
