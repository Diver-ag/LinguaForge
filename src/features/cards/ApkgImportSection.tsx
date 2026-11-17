import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { db, type CardType, type DeckItem } from '../../db/db';
import {
  ANKI_REEXPORT_HELP_MESSAGE,
  APKG_CARD_FIELD_OPTIONS,
  ankiHtmlToPlainText,
  buildFailedApkgNotesCsv,
  createApkgWriteSession,
  finalizeApkgImportSideEffects,
  parseAnkiFuriganaField,
  processApkgNoteBatch,
  type ApkgCardField,
  type ApkgFailedNote,
  type ApkgImportResult,
  type ApkgInspectSummary,
  type ApkgWriteSessionContext,
} from '../../core/ankiImportCore';
import type { DuplicateImportMode } from '../../core/cardCsvImport';
import type {
  AnkiImportWorkerRequest,
  AnkiImportWorkerResponse,
} from './ankiImport.worker';
import { useAppStore } from '../../store/useAppStore';
import { getLanguagePack } from '../../packs/registry';
import { FuriganaText } from '../../ui/FuriganaText';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileArchive,
  FolderPlus,
  Info,
  Loader2,
  Upload,
  X,
} from 'lucide-react';

const APKG_MAPPINGS_SETTINGS_KEY = 'cardApkgImportMappings';

const CARD_TYPE_OPTIONS: { value: CardType; label: string }[] = [
  { value: 'word_to_meaning', label: 'Word → Meaning' },
  { value: 'meaning_to_word', label: 'Meaning → Word' },
  { value: 'reading', label: 'Reading' },
];

interface ApkgImportSectionProps {
  decks: DeckItem[];
  isLoadingDecks: boolean;
  onDecksChanged: () => Promise<void>;
}

export const ApkgImportSection: React.FC<ApkgImportSectionProps> = ({
  decks,
  isLoadingDecks,
  onDecksChanged,
}) => {
  const { activeLanguageId } = useAppStore();
  const pack = getLanguagePack(activeLanguageId);

  const [fileName, setFileName] = useState('');
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ApkgInspectSummary | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelMappings, setModelMappings] = useState<Record<string, ApkgCardField[]>>({});

  // Options
  const [deckMode, setDeckMode] = useState<'keep' | 'target'>('keep');
  const [targetDeckChoice, setTargetDeckChoice] = useState<string>('');
  const [newDeckName, setNewDeckName] = useState<string>('');
  const [cardType, setCardType] = useState<CardType>('word_to_meaning');
  const [duplicateMode, setDuplicateMode] = useState<DuplicateImportMode>('skip');
  const [importAsNewOnly, setImportAsNewOnly] = useState<boolean>(true);

  // Import state
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<{ processed: number; total: number; percent: number } | null>(
    null
  );
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ApkgImportResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const cancelledRef = useRef<boolean>(false);

  useEffect(() => {
    if (decks.length > 0 && !targetDeckChoice) {
      setTargetDeckChoice(decks[0].id);
    }
  }, [decks, targetDeckChoice]);

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'close' } satisfies AnkiImportWorkerRequest);
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  const getWorker = useCallback(() => {
    if (!workerRef.current) {
      workerRef.current = new Worker(new URL('./ankiImport.worker.ts', import.meta.url), {
        type: 'module',
      });
    }
    return workerRef.current;
  }, []);

  const loadSavedModelMappings = async (): Promise<Record<string, ApkgCardField[]>> => {
    try {
      const item = await db.settings.get(APKG_MAPPINGS_SETTINGS_KEY);
      if (item?.value && typeof item.value === 'object') {
        return item.value as Record<string, ApkgCardField[]>;
      }
    } catch {
      // Ignore read errors
    }
    return {};
  };

  const persistModelMappings = async (
    nextMappings: Record<string, ApkgCardField[]>,
    inspectSum: ApkgInspectSummary
  ) => {
    try {
      const saved = await loadSavedModelMappings();
      for (const nt of inspectSum.noteTypes) {
        const sig = `${nt.id}:${nt.fieldNames.join('|')}`;
        if (nextMappings[nt.id]) {
          saved[sig] = nextMappings[nt.id];
        }
      }
      await db.settings.put({
        key: APKG_MAPPINGS_SETTINGS_KEY,
        value: saved,
      });
    } catch {
      // Non-fatal
    }
  };

  const handleApkgFileSelected = async (file: File) => {
    setFileName(file.name);
    setInspectError(null);
    setImportError(null);
    setImportResult(null);
    setSummary(null);
    setIsInspecting(true);

    try {
      const buffer = await file.arrayBuffer();
      const worker = getWorker();
      const jobId = `inspect-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      activeJobIdRef.current = jobId;

      const savedMap = await loadSavedModelMappings();

      await new Promise<void>((resolve, reject) => {
        const onMsg = (ev: MessageEvent<AnkiImportWorkerResponse>) => {
          const d = ev.data;
          if (!d || d.jobId !== jobId) return;

          if (d.type === 'inspect_done') {
            worker.removeEventListener('message', onMsg);
            worker.removeEventListener('error', onErr);

            const initialMappings: Record<string, ApkgCardField[]> = {};
            for (const nt of d.summary.noteTypes) {
              const sig = `${nt.id}:${nt.fieldNames.join('|')}`;
              const remembered = savedMap[sig];
              if (Array.isArray(remembered) && remembered.length === nt.fieldNames.length) {
                initialMappings[nt.id] = remembered;
              } else {
                initialMappings[nt.id] = [...nt.defaultMapping];
              }
            }

            setSummary(d.summary);
            setModelNames(d.modelNames);
            setModelMappings(initialMappings);
            resolve();
          } else if (d.type === 'error') {
            worker.removeEventListener('message', onMsg);
            worker.removeEventListener('error', onErr);
            reject(new Error(d.error || 'Failed to read .apkg file.'));
          }
        };

        const onErr = (err: ErrorEvent) => {
          worker.removeEventListener('message', onMsg);
          worker.removeEventListener('error', onErr);
          reject(new Error(err.message || 'Anki import worker error.'));
        };

        worker.addEventListener('message', onMsg);
        worker.addEventListener('error', onErr);

        worker.postMessage(
          {
            type: 'inspect',
            jobId,
            apkgBuffer: buffer,
            sqlWasmUrl: `${window.location.origin}/sql-wasm.wasm`,
          } satisfies AnkiImportWorkerRequest,
          [buffer]
        );
      });
    } catch (err: any) {
      const msg = err?.message || 'Could not inspect this .apkg package.';
      setInspectError(msg);
    } finally {
      setIsInspecting(false);
    }
  };

  const handleFieldMappingChange = async (
    modelId: string,
    fieldIndex: number,
    nextField: ApkgCardField
  ) => {
    if (!summary) return;
    const nt = summary.noteTypes.find((n) => n.id === modelId);
    const cur = [...(modelMappings[modelId] || [])];
    while (nt && cur.length < nt.fieldNames.length) cur.push('ignore');
    cur[fieldIndex] = nextField;
    const nextAll = { ...modelMappings, [modelId]: cur };
    setModelMappings(nextAll);
    await persistModelMappings(nextAll, summary);
  };

  const allActiveNoteTypesReady = Boolean(
    summary &&
      summary.noteTypes.every((nt) => {
        if (nt.noteCount === 0) return true;
        const mapped = modelMappings[nt.id] || [];
        return nt.isClozeModel
          ? mapped.includes('sentence') || mapped.includes('word')
          : mapped.includes('word');
      })
  );

  const handleCancelImport = () => {
    cancelledRef.current = true;
    const jobId = activeJobIdRef.current;
    if (workerRef.current && jobId) {
      workerRef.current.postMessage({
        type: 'cancel',
        jobId,
      } satisfies AnkiImportWorkerRequest);
    }
  };

  const handleStartImport = async () => {
    if (!summary || isImporting || summary.totalNotes === 0) return;
    setImportError(null);
    setImportResult(null);

    if (!allActiveNoteTypesReady) {
      setImportError(
        'Every note type must have "Word" mapped (or "Sentence" for Cloze note types).'
      );
      return;
    }

    if (deckMode === 'target' && targetDeckChoice === '__new__' && !newDeckName.trim()) {
      setImportError('Please enter a name for the new target deck.');
      return;
    }

    await persistModelMappings(modelMappings, summary);

    cancelledRef.current = false;
    setIsImporting(true);
    setProgress({ processed: 0, total: summary.totalNotes, percent: 0 });

    const jobId = `import-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    activeJobIdRef.current = jobId;

    const modelIsClozeMap = new Map(
      summary.noteTypes.map((nt) => [nt.id, Boolean(nt.isClozeModel)])
    );
    const modelFieldNamesMap = new Map(
      summary.noteTypes.map((nt) => [nt.id, nt.fieldNames])
    );

    let sessionCtx: ApkgWriteSessionContext;
    try {
      sessionCtx = await createApkgWriteSession(
        {
          languageId: activeLanguageId,
          modelMappings,
          deckMode,
          targetDeckId: targetDeckChoice === '__new__' ? undefined : targetDeckChoice,
          newDeckName: targetDeckChoice === '__new__' ? newDeckName.trim() : undefined,
          cardType,
          duplicateMode,
          importAsNewOnly,
        },
        new Map(Object.entries(modelNames)),
        modelIsClozeMap,
        modelFieldNamesMap
      );
    } catch (err: any) {
      setIsImporting(false);
      setImportError(err?.message || 'Failed to prepare decks for import.');
      return;
    }

    let notesRead = 0;
    let cardsCreated = 0;
    let clozeCardsCreated = 0;
    let unsupportedClozeCount = 0;
    let cardsUpdated = 0;
    let skippedDuplicates = 0;
    const clozeNotices: string[] = [];
    const failedNotes: ApkgFailedNote[] = [];

    // Sequential write queue so streamed batches commit in strict order
    let writeQueue: Promise<void> = Promise.resolve();
    const worker = getWorker();

    try {
      const finalStatus = await new Promise<{ cancelled: boolean }>((resolve, reject) => {
        const onMsg = (ev: MessageEvent<AnkiImportWorkerResponse>) => {
          const d = ev.data;
          if (!d || d.jobId !== jobId) return;

          if (d.type === 'note_batch') {
            const batch = d.batch;
            const processedCount = d.processed;
            const totalCount = Math.max(1, d.total);
            writeQueue = writeQueue.then(async () => {
              if (cancelledRef.current) return;
              const stats = await processApkgNoteBatch(batch, sessionCtx);
              notesRead += batch.length;
              cardsCreated += stats.created;
              clozeCardsCreated += stats.clozeCreated;
              unsupportedClozeCount += stats.unsupportedClozeCount;
              cardsUpdated += stats.updated;
              skippedDuplicates += stats.skippedDuplicates;
              if (stats.clozeWarnings.length > 0 && clozeNotices.length < 50) {
                clozeNotices.push(...stats.clozeWarnings.slice(0, 50 - clozeNotices.length));
              }
              if (stats.failed.length > 0) {
                failedNotes.push(...stats.failed);
              }
              setProgress({
                processed: processedCount,
                total: totalCount,
                percent: Math.min(99, Math.round((processedCount / totalCount) * 100)),
              });
            });
            return;
          }

          if (d.type === 'stream_done') {
            worker.removeEventListener('message', onMsg);
            worker.removeEventListener('error', onErr);
            writeQueue
              .then(() => resolve({ cancelled: d.cancelled || cancelledRef.current }))
              .catch(reject);
            return;
          }

          if (d.type === 'error') {
            worker.removeEventListener('message', onMsg);
            worker.removeEventListener('error', onErr);
            reject(new Error(d.error || 'Failed while importing Anki notes.'));
          }
        };

        const onErr = (err: ErrorEvent) => {
          worker.removeEventListener('message', onMsg);
          worker.removeEventListener('error', onErr);
          reject(new Error(err.message || 'Anki import worker crashed.'));
        };

        worker.addEventListener('message', onMsg);
        worker.addEventListener('error', onErr);

        worker.postMessage({
          type: 'stream_notes',
          jobId,
          batchSize: 400,
        } satisfies AnkiImportWorkerRequest);
      });

      const finalResult: ApkgImportResult = {
        notesRead,
        cardsCreated,
        clozeCardsCreated,
        unsupportedClozeCount,
        clozeNotices,
        cardsUpdated,
        skippedDuplicates,
        skippedMediaCount: summary.skippedMediaCount,
        createdDeckNames: Array.from(new Set(sessionCtx.createdDeckNames)),
        failedNotes,
        cancelled: finalStatus.cancelled,
      };

      await finalizeApkgImportSideEffects(finalResult, activeLanguageId);
      setProgress({
        processed: notesRead,
        total: Math.max(1, summary.totalNotes),
        percent: 100,
      });
      setImportResult(finalResult);
      await onDecksChanged();
      if (deckMode === 'target' && targetDeckChoice === '__new__' && finalResult.createdDeckNames.length > 0) {
        setNewDeckName('');
      }
    } catch (err: any) {
      setImportError(err?.message || 'Import failed unexpectedly.');
    } finally {
      activeJobIdRef.current = null;
      setIsImporting(false);
    }
  };

  const handleDownloadFailedNotes = () => {
    if (!importResult || importResult.failedNotes.length === 0) return;
    const { fileName: errName, bytes } = buildFailedApkgNotesCsv(importResult.failedNotes);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = errName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Step 1: Select .apkg File */}
      <section
        aria-label="Choose Anki Package"
        className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold text-sm text-[var(--text)]">
            1. Choose Anki package (.apkg)
          </h2>
          {fileName && summary && (
            <div className="text-xs text-[var(--text-muted)] tabular-nums">
              <span className="font-semibold text-[var(--text)]">{fileName}</span>
              {' · '}
              <span>{summary.dbSource}</span>
              {' · '}
              <span>{summary.totalNotes.toLocaleString()} notes</span>
            </div>
          )}
        </div>

        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={async (e) => {
            e.preventDefault();
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) await handleApkgFileSelected(dropped);
          }}
          className="p-6 rounded-2xl border-2 border-dashed border-[var(--border)] bg-[var(--surface-muted)]/50 flex flex-col sm:flex-row items-center justify-between gap-4"
        >
          <div className="space-y-1 text-center sm:text-left">
            <div className="text-sm font-bold text-[var(--text)] flex items-center justify-center sm:justify-start gap-2">
              <FileArchive className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>Drop an .apkg file here or browse</span>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              Supports modern <code className="font-mono">collection.anki21b</code> (zstd),{' '}
              <code className="font-mono">collection.anki21</code>, and legacy{' '}
              <code className="font-mono">collection.anki2</code> packages completely offline.
            </p>
          </div>

          <div className="shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".apkg,application/zip"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) await handleApkgFileSelected(file);
              }}
              className="hidden"
              aria-label="Choose Anki .apkg file"
            />
            <button
              type="button"
              disabled={isInspecting || isImporting}
              onClick={() => fileInputRef.current?.click()}
              className="min-h-[44px] px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold inline-flex items-center gap-2 transition whitespace-nowrap"
            >
              {isInspecting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              <span>
                {isInspecting ? 'Inspecting package...' : fileName ? 'Choose another .apkg' : 'Select .apkg file'}
              </span>
            </button>
          </div>
        </div>

        {inspectError && (
          <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 flex items-start gap-2.5 text-xs text-rose-800 dark:text-rose-200">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
            <div className="space-y-1">
              <div className="font-bold">Unable to open Anki package</div>
              <div>{inspectError}</div>
              {inspectError === ANKI_REEXPORT_HELP_MESSAGE && (
                <div className="text-[11px] opacity-90">
                  In Anki Desktop: File → Export → Format: Anki Deck Package (.apkg) → tick &ldquo;Support older Anki versions&rdquo;.
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Step 2: Package Preview */}
      {summary && (
        <section
          aria-label="Anki Package Preview"
          className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-bold text-sm text-[var(--text)]">
              2. Package preview
            </h2>
            <span className="text-xs text-[var(--text-muted)] font-mono">
              Database: {summary.dbSource}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs tabular-nums">
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-[11px] text-[var(--text-muted)]">Notes found</div>
              <div className="text-lg font-black text-[var(--text)] mt-0.5">
                {summary.totalNotes.toLocaleString()}
              </div>
            </div>
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-[11px] text-[var(--text-muted)]">Decks found</div>
              <div className="text-lg font-black text-[var(--text)] mt-0.5">
                {summary.decks.length}
              </div>
            </div>
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-[11px] text-[var(--text-muted)]">Note types</div>
              <div className="text-lg font-black text-[var(--text)] mt-0.5">
                {summary.noteTypes.length}
              </div>
            </div>
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-[11px] text-[var(--text-muted)]">Skipped media files</div>
              <div className="text-lg font-black text-[var(--text)] mt-0.5">
                {summary.skippedMediaCount.toLocaleString()}
              </div>
            </div>
          </div>

          {summary.skippedMediaCount > 0 && (
            <div className="p-3 rounded-2xl bg-[var(--surface-muted)]/70 border border-[var(--border)] flex items-start gap-2 text-xs text-[var(--text-secondary)]">
              <Info className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
              <span>
                Media files (audio/images) are not imported yet —{' '}
                <strong className="tabular-nums">
                  {summary.skippedMediaCount.toLocaleString()}
                </strong>{' '}
                media {summary.skippedMediaCount === 1 ? 'file' : 'files'} will be skipped safely.
              </span>
            </div>
          )}

          {/* Decks & Note Types list */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="p-4 rounded-2xl bg-[var(--surface-muted)]/60 border border-[var(--border)] space-y-2">
              <div className="font-bold text-[var(--text)]">Decks in package</div>
              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {summary.decks.map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-[var(--text)]">{d.name}</span>
                    <span className="text-[var(--text-muted)] tabular-nums shrink-0">
                      {d.noteCount.toLocaleString()} notes
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-[var(--surface-muted)]/60 border border-[var(--border)] space-y-2">
              <div className="font-bold text-[var(--text)]">Note types (models)</div>
              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {summary.noteTypes.map((nt) => (
                  <div key={nt.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-[var(--text)]">
                      {nt.name} ({nt.fieldNames.length} fields
                      {nt.isClozeModel ? ' · Cloze' : ''})
                    </span>
                    <span className="text-[var(--text-muted)] tabular-nums shrink-0">
                      {nt.noteCount.toLocaleString()} notes
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Sample Note */}
          {summary.sampleNote && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-[var(--text-muted)]">
                Sample note · {summary.sampleNote.noteTypeName} · Deck: {summary.sampleNote.deckName}
                {summary.sampleNote.tags.length > 0 && ` · Tags: ${summary.sampleNote.tags.join(', ')}`}
              </div>
              <div className="overflow-x-auto rounded-2xl border border-[var(--border)]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                      <th className="py-2 px-3 font-semibold">Anki Field</th>
                      <th className="py-2 px-3 font-semibold">Preview</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {summary.sampleNote.fields.map((f, idx) => {
                      const parsedFurigana = parseAnkiFuriganaField(f.raw);
                      return (
                        <tr key={idx}>
                          <td className="py-2 px-3 font-semibold text-[var(--text-secondary)] whitespace-nowrap">
                            {f.name}
                          </td>
                          <td className="py-2 px-3 text-[var(--text)] max-w-xl break-words">
                            {parsedFurigana.segments && parsedFurigana.segments.length > 0 ? (
                              <FuriganaText
                                segments={parsedFurigana.segments}
                                text={parsedFurigana.plainText}
                                furiganaMode="always"
                              />
                            ) : (
                              f.plainText || '—'
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
      )}

      {/* Step 3: Per-Note-Type Field Mapping */}
      {summary && summary.noteTypes.length > 0 && (
        <section
          aria-label="Field Mapping per Note Type"
          className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-5"
        >
          <div className="space-y-0.5">
            <h2 className="font-bold text-sm text-[var(--text)]">
              3. Map fields per note type
            </h2>
            <p className="text-xs text-[var(--text-muted)]">
              Common Anki fields (Expression, Reading, Meaning, Sentence, Vocab-kanji) are auto-detected. Anki bracket furigana (<code className="font-mono">漢字[かんじ]</code>) and <code className="font-mono">&lt;ruby&gt;</code> HTML convert automatically.
            </p>
          </div>

          {!allActiveNoteTypesReady && (
            <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300/70 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>
                Map at least one field to <strong>Word</strong> for standard note types (or{' '}
                <strong>Sentence</strong> for Cloze note types).
              </span>
            </div>
          )}

          <div className="space-y-5">
            {summary.noteTypes.map((nt) => {
              const curMap = modelMappings[nt.id] || nt.defaultMapping;
              return (
                <div
                  key={nt.id}
                  className="p-4 rounded-2xl bg-[var(--surface-muted)]/50 border border-[var(--border)] space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-bold text-[var(--text)]">
                      {nt.name}
                      {nt.isClozeModel && (
                        <span className="ml-2 text-[11px] font-semibold text-[var(--accent-text)]">
                          (Cloze · auto-converts {'{{c1::…}}'} deletions)
                        </span>
                      )}
                    </span>
                    <span className="text-[var(--text-muted)] tabular-nums">
                      {nt.noteCount.toLocaleString()} notes · {nt.fieldNames.length} fields
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                    {nt.fieldNames.map((fName, colIdx) => {
                      const sample = ankiHtmlToPlainText(nt.sampleFields[colIdx] || '');
                      const mappedTo = curMap[colIdx] || 'ignore';
                      return (
                        <div
                          key={`${nt.id}-${colIdx}`}
                          className={`p-3 rounded-2xl border space-y-2 ${
                            mappedTo !== 'ignore'
                              ? 'border-indigo-500/60 bg-[var(--accent-subtle)]/40'
                              : 'border-[var(--border)] bg-[var(--surface)]'
                          }`}
                        >
                          <div className="space-y-0.5">
                            <div className="font-bold text-[var(--text)] truncate" title={fName}>
                              {fName}
                            </div>
                            <div
                              className="text-[11px] text-[var(--text-muted)] truncate"
                              title={sample}
                            >
                              Sample: {sample || '—'}
                            </div>
                          </div>

                          <select
                            value={mappedTo}
                            onChange={(e) =>
                              handleFieldMappingChange(
                                nt.id,
                                colIdx,
                                e.target.value as ApkgCardField
                              )
                            }
                            aria-label={`Map ${nt.name} field ${fName}`}
                            className="w-full min-h-[38px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] font-semibold"
                          >
                            {APKG_CARD_FIELD_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Step 4: Options & Import */}
      {summary && summary.totalNotes > 0 && (
        <section
          aria-label="Anki Import Options"
          className="p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] space-y-5"
        >
          <h2 className="font-bold text-sm text-[var(--text)]">
            4. Import options
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {/* Deck Destination */}
            <div className="space-y-2">
              <span className="font-semibold text-[var(--text-secondary)] block">
                Deck destination
              </span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => setDeckMode('keep')}
                  className={`min-h-[40px] px-3 py-2 rounded-xl border font-semibold transition ${
                    deckMode === 'keep'
                      ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                      : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]'
                  }`}
                >
                  Keep Anki deck names
                </button>
                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => setDeckMode('target')}
                  className={`min-h-[40px] px-3 py-2 rounded-xl border font-semibold transition ${
                    deckMode === 'target'
                      ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                      : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]'
                  }`}
                >
                  Use target deck
                </button>
              </div>

              {deckMode === 'target' && (
                <div className="space-y-2 pt-1">
                  <select
                    value={targetDeckChoice}
                    onChange={(e) => setTargetDeckChoice(e.target.value)}
                    disabled={isLoadingDecks || isImporting}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] font-medium"
                  >
                    {decks.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                    <option value="__new__">+ Create new deck...</option>
                  </select>

                  {targetDeckChoice === '__new__' && (
                    <div className="flex items-center gap-2">
                      <FolderPlus className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                      <input
                        type="text"
                        value={newDeckName}
                        onChange={(e) => setNewDeckName(e.target.value)}
                        placeholder="New deck name"
                        disabled={isImporting}
                        className="flex-1 min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Card Type */}
            <div className="space-y-2">
              <label className="font-semibold text-[var(--text-secondary)] block">
                Card type to create ({pack.flagEmoji} {pack.name})
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
                  Leave existing cards untouched and skip matching notes.
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
                <div className="font-bold">Update existing cards</div>
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
                  Create a new card for every valid note.
                </div>
              </button>
            </div>
          </div>

          {/* Scheduling Disclaimer */}
          <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)]/70 border border-[var(--border)] space-y-1.5 text-xs">
            <label className="inline-flex items-center gap-2 font-semibold text-[var(--text)] cursor-pointer">
              <input
                type="checkbox"
                checked={importAsNewOnly}
                onChange={(e) => setImportAsNewOnly(e.target.checked)}
                disabled={isImporting}
                className="w-4 h-4 accent-indigo-600 rounded"
              />
              <span>Import review history as new cards only</span>
            </label>
            <p className="text-[11px] text-[var(--text-muted)] pl-6 leading-relaxed">
              Anki review history and scheduling intervals are <strong>NOT imported</strong>. All imported cards start as fresh New cards in LinguaForge&apos;s FSRS scheduler.
            </p>
          </div>

          {/* Start / Cancel Action */}
          <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-[var(--text-muted)] tabular-nums">
              Ready to import <strong>{summary.totalNotes.toLocaleString()}</strong> notes in batches
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
                disabled={!allActiveNoteTypesReady}
                className="min-h-[44px] px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-xs font-bold inline-flex items-center gap-2 shadow-sm transition active:scale-95"
              >
                <Upload className="w-4 h-4" />
                <span>Import {summary.totalNotes.toLocaleString()} notes</span>
              </button>
            )}
          </div>

          {isImporting && progress && (
            <div className="p-4 rounded-2xl bg-[var(--accent-subtle)] border border-indigo-500/30 space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-[var(--accent-text)]">
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>
                    Importing notes ({progress.processed.toLocaleString()} /{' '}
                    {progress.total.toLocaleString()})...
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
          aria-label="Anki Import Summary"
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
                  {importResult.cancelled ? 'Anki import cancelled' : 'Anki import complete'}
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

          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-xs tabular-nums">
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-[11px] text-[var(--text-muted)]">Notes read</div>
              <div className="text-lg font-black text-[var(--text)] mt-0.5">
                {importResult.notesRead.toLocaleString()}
              </div>
            </div>
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-[11px] text-[var(--text-muted)]">Cards created</div>
              <div className="text-lg font-black text-emerald-600 dark:text-emerald-400 mt-0.5">
                {importResult.cardsCreated.toLocaleString()}
              </div>
              {(importResult.clozeCardsCreated ?? 0) > 0 && (
                <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                  {importResult.clozeCardsCreated?.toLocaleString()} cloze
                </div>
              )}
            </div>
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-[11px] text-[var(--text-muted)]">Cards updated</div>
              <div className="text-lg font-black text-indigo-600 dark:text-indigo-400 mt-0.5">
                {importResult.cardsUpdated.toLocaleString()}
              </div>
            </div>
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-[11px] text-[var(--text-muted)]">Skipped dupes</div>
              <div className="text-lg font-black text-[var(--text)] mt-0.5">
                {importResult.skippedDuplicates.toLocaleString()}
              </div>
            </div>
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-[11px] text-[var(--text-muted)]">Skipped media</div>
              <div className="text-lg font-black text-[var(--text)] mt-0.5">
                {importResult.skippedMediaCount.toLocaleString()}
              </div>
            </div>
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-[11px] text-[var(--text-muted)]">Errors</div>
              <div
                className={`text-lg font-black mt-0.5 ${
                  importResult.failedNotes.length > 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-[var(--text)]'
                }`}
              >
                {importResult.failedNotes.length.toLocaleString()}
              </div>
            </div>
          </div>

          {((importResult.unsupportedClozeCount ?? 0) > 0 ||
            (importResult.clozeNotices && importResult.clozeNotices.length > 0)) && (
            <div className="p-3.5 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300/70 dark:border-amber-800 space-y-1.5 text-xs text-amber-900 dark:text-amber-200">
              <div className="font-bold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>Cloze import notices</span>
              </div>
              {(importResult.unsupportedClozeCount ?? 0) > 0 && (
                <div>
                  Skipped <strong>{importResult.unsupportedClozeCount}</strong> note(s) with unsupported cloze constructs (nested cloze tags or empty blanks — see Errors below).
                </div>
              )}
              {importResult.clozeNotices && importResult.clozeNotices.length > 0 && (
                <ul className="list-disc pl-5 space-y-0.5 text-[11px] opacity-90">
                  {importResult.clozeNotices.slice(0, 8).map((msg, idx) => (
                    <li key={idx}>{msg}</li>
                  ))}
                  {importResult.clozeNotices.length > 8 && (
                    <li>…and {importResult.clozeNotices.length - 8} more multi-cloze note(s)</li>
                  )}
                </ul>
              )}
            </div>
          )}

          {importResult.failedNotes.length > 0 && (
            <div className="space-y-3 pt-2 border-t border-[var(--border)]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-bold text-rose-700 dark:text-rose-300">
                  Failed notes ({importResult.failedNotes.length.toLocaleString()})
                </div>
                <button
                  type="button"
                  onClick={handleDownloadFailedNotes}
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
                      <th className="py-2 px-3 font-semibold tabular-nums">Note ID</th>
                      <th className="py-2 px-3 font-semibold">Note Type</th>
                      <th className="py-2 px-3 font-semibold">Word</th>
                      <th className="py-2 px-3 font-semibold">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {importResult.failedNotes.slice(0, 50).map((f, idx) => (
                      <tr key={`${f.noteId}-${idx}`}>
                        <td className="py-2 px-3 font-mono tabular-nums text-[var(--text-muted)]">
                          {f.noteId}
                        </td>
                        <td className="py-2 px-3 text-[var(--text-secondary)]">{f.modelName}</td>
                        <td className="py-2 px-3 font-semibold text-[var(--text)]">
                          {f.word || '—'}
                        </td>
                        <td className="py-2 px-3 text-rose-700 dark:text-rose-300">{f.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
};
