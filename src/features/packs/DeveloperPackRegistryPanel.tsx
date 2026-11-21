import React, { useState, useMemo } from 'react';
import { getAllLanguagePacks, getLanguagePack } from '../../packs/registry';
import { formatPackBytes } from '../../core/languagePack';
import {
  addCustomBundledPackByUrl,
  addCustomBundledPackFromFile,
  BUNDLED_PACK_CATEGORY_LABELS,
  previewCsvOrTsvForDeveloper,
  readTextFromFileOrBytes,
  removeBundledPackFromRegistry,
  restoreDefaultBundledPacks,
  runBundledPacksCheck,
  type BundledPackCategory,
  type BundledPackDefinition,
  type InstalledBundledPackStatus,
  type PackCheckRow,
} from '../../core/bundledPacks';
import {
  BUNDLED_PACK_CATEGORIES,
  CATEGORY_FIELD_DEFINITIONS,
  type ParsedDelimitedTable,
} from '../../core/packCsvParser';
import {
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  Link2,
  CheckCircle2,
  AlertCircle,
  Table,
  X,
  Stethoscope,
  Loader2,
} from 'lucide-react';

export interface DeveloperPackRegistryPanelProps {
  packs: BundledPackDefinition[];
  removedDefaultIds: string[];
  installedBundlesMap: Record<string, InstalledBundledPackStatus>;
  onRegistryChanged: () => Promise<void> | void;
}

interface PendingCsvMappingState {
  fileName: string;
  languageId: string;
  category: BundledPackCategory;
  title: string;
  sizeBytes: number;
  rawBytes: Uint8Array;
  table: ParsedDelimitedTable;
  mapping: Record<string, number>;
  missingRequired: string[];
}

export const DeveloperPackRegistryPanel: React.FC<DeveloperPackRegistryPanelProps> = ({
  packs,
  removedDefaultIds,
  installedBundlesMap,
  onRegistryChanged,
}) => {
  const allLanguages = getAllLanguagePacks();

  const [filterLang, setFilterLang] = useState<string>('all');
  const [showAddForm, setShowAddForm] = useState(false);
  const [addMode, setAddMode] = useState<'file' | 'url'>('file');

  // Add Pack form fields
  const [newLangId, setNewLangId] = useState<string>('ja');
  const [newCategory, setNewCategory] = useState<BundledPackCategory>('common-dict');
  const [newTitle, setNewTitle] = useState('');
  const [newUrl, setNewUrl] = useState('');

  // Quick CSV/TSV column-mapping preview state (shown when header auto-detection fails)
  const [pendingCsvPreview, setPendingCsvPreview] = useState<PendingCsvMappingState | null>(null);

  // Inline confirmations & feedback
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [clearDbOnRemove, setClearDbOnRemove] = useState<boolean>(true);
  const [confirmRestoreDefaults, setConfirmRestoreDefaults] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [statusFeedback, setStatusFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Pack check diagnostics state
  const [isCheckingPacks, setIsCheckingPacks] = useState(false);
  const [packCheckProgress, setPackCheckProgress] = useState<{ checked: number; total: number } | null>(
    null
  );
  const [packCheckResults, setPackCheckResults] = useState<PackCheckRow[] | null>(null);

  const visiblePacks = useMemo(() => {
    if (filterLang === 'all') return packs;
    return packs.filter((p) => p.languageId === filterLang);
  }, [packs, filterLang]);

  const customPackCount = useMemo(
    () => packs.filter((p) => p.origin === 'custom').length,
    [packs]
  );

  const hasCustomizations = removedDefaultIds.length > 0 || customPackCount > 0;

  const handleAddUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusFeedback(null);
    if (!newUrl.trim()) {
      setStatusFeedback({ type: 'error', message: 'Enter a /packs/... path or HTTPS URL.' });
      return;
    }
    setBusyAction(true);
    try {
      const added = await addCustomBundledPackByUrl({
        languageId: newLangId,
        category: newCategory,
        title: newTitle,
        url: newUrl,
      });
      setNewTitle('');
      setNewUrl('');
      setShowAddForm(false);
      await onRegistryChanged();
      setStatusFeedback({
        type: 'success',
        message: `Added "${added.title}" (${BUNDLED_PACK_CATEGORY_LABELS[added.category]}) to ${getLanguagePack(added.languageId).name}.`,
      });
    } catch (err: any) {
      setStatusFeedback({ type: 'error', message: err?.message || 'Failed to add pack URL.' });
    } finally {
      setBusyAction(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setStatusFeedback(null);
    setBusyAction(true);

    try {
      const buf = await file.arrayBuffer();
      const rawBytes = new Uint8Array(buf);
      const lower = file.name.toLowerCase();
      const isTabular = lower.endsWith('.csv') || lower.endsWith('.tsv');
      const resolvedTitle =
        newTitle.trim() || file.name.replace(/\.(json\.gz|json|csv|tsv)$/i, '');

      if (isTabular) {
        const { text } = await readTextFromFileOrBytes(rawBytes, file.name);
        const { table, detection } = await previewCsvOrTsvForDeveloper(
          newCategory,
          text,
          file.name
        );
        if (table.rows.length === 0) {
          throw new Error(`No data rows found in "${file.name}".`);
        }

        if (!detection.autoDetected) {
          setPendingCsvPreview({
            fileName: file.name,
            languageId: newLangId,
            category: newCategory,
            title: resolvedTitle,
            sizeBytes: file.size,
            rawBytes,
            table,
            mapping: { ...detection.mapping },
            missingRequired: detection.missingRequired,
          });
          setBusyAction(false);
          return;
        }

        const added = await addCustomBundledPackFromFile({
          languageId: newLangId,
          category: newCategory,
          title: resolvedTitle,
          fileName: file.name,
          mimeType: file.type || 'text/csv',
          data: text,
          sizeBytes: file.size,
          columnMapping: detection.mapping,
        });

        setNewTitle('');
        setShowAddForm(false);
        await onRegistryChanged();
        setStatusFeedback({
          type: 'success',
          message: `Added "${added.title}" (${table.rows.length.toLocaleString()} rows auto-mapped).`,
        });
      } else {
        const added = await addCustomBundledPackFromFile({
          languageId: newLangId,
          category: newCategory,
          title: resolvedTitle,
          fileName: file.name,
          mimeType: file.type || 'application/json',
          data: rawBytes,
          sizeBytes: file.size,
        });

        setNewTitle('');
        setShowAddForm(false);
        await onRegistryChanged();
        setStatusFeedback({
          type: 'success',
          message: `Added "${added.title}" (${formatPackBytes(file.size)}) to offline bundle registry.`,
        });
      }
    } catch (err: any) {
      setStatusFeedback({
        type: 'error',
        message: err?.message || 'Failed to read uploaded pack file.',
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleConfirmCsvMapping = async () => {
    if (!pendingCsvPreview) return;
    setBusyAction(true);
    setStatusFeedback(null);

    try {
      const { text } = await readTextFromFileOrBytes(
        pendingCsvPreview.rawBytes,
        pendingCsvPreview.fileName
      );
      const added = await addCustomBundledPackFromFile({
        languageId: pendingCsvPreview.languageId,
        category: pendingCsvPreview.category,
        title: pendingCsvPreview.title,
        fileName: pendingCsvPreview.fileName,
        mimeType: 'text/csv',
        data: text,
        sizeBytes: pendingCsvPreview.sizeBytes,
        columnMapping: pendingCsvPreview.mapping,
      });

      setPendingCsvPreview(null);
      setNewTitle('');
      setShowAddForm(false);
      await onRegistryChanged();
      setStatusFeedback({
        type: 'success',
        message: `Added "${added.title}" with custom column mapping (${pendingCsvPreview.table.rows.length.toLocaleString()} rows).`,
      });
    } catch (err: any) {
      setStatusFeedback({
        type: 'error',
        message: err?.message || 'Failed to save mapped CSV/TSV pack.',
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleConfirmRemove = async (pack: BundledPackDefinition) => {
    setBusyAction(true);
    setStatusFeedback(null);
    try {
      await removeBundledPackFromRegistry(pack.id, {
        clearDbEntries: clearDbOnRemove,
      });
      setConfirmRemoveId(null);
      await onRegistryChanged();
      setStatusFeedback({
        type: 'success',
        message: clearDbOnRemove
          ? `Removed "${pack.title}" from bundle and cleared its database entries.`
          : `Excluded "${pack.title}" from Normal Mode "Install All" bundles.`,
      });
    } catch (err: any) {
      setStatusFeedback({
        type: 'error',
        message: err?.message || 'Failed to remove pack.',
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleConfirmRestoreDefaults = async () => {
    setBusyAction(true);
    setStatusFeedback(null);
    try {
      await restoreDefaultBundledPacks();
      setConfirmRestoreDefaults(false);
      await onRegistryChanged();
      setStatusFeedback({
        type: 'success',
        message: 'Restored default author pack registry.',
      });
    } catch (err: any) {
      setStatusFeedback({
        type: 'error',
        message: err?.message || 'Failed to restore default packs.',
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleRunPackCheck = async () => {
    setIsCheckingPacks(true);
    setPackCheckProgress({ checked: 0, total: packs.length });
    setStatusFeedback(null);
    try {
      const results = await runBundledPacksCheck(packs, {
        maxRows: 100,
        onProgress: (checked, total) => setPackCheckProgress({ checked, total }),
      });
      setPackCheckResults(results);
    } catch (err: any) {
      setStatusFeedback({
        type: 'error',
        message: err?.message || 'Pack check failed.',
      });
    } finally {
      setIsCheckingPacks(false);
      setPackCheckProgress(null);
    }
  };

  return (
    <section
      aria-label="Included Packs Registry (Developer)"
      data-testid="developer-pack-registry"
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 space-y-4"
    >
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-bold text-[var(--text)]">
            Included Packs Registry (Developer)
          </h3>
          <p className="text-xs text-[var(--text-muted)] tabular-nums">
            {packs.length} active bundled packs across 10 languages
            {removedDefaultIds.length > 0 ? ` · ${removedDefaultIds.length} excluded` : ''}
            {customPackCount > 0 ? ` · ${customPackCount} custom` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filterLang}
            onChange={(e) => setFilterLang(e.target.value)}
            aria-label="Filter registry by language"
            className="min-h-[36px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-xs font-semibold text-[var(--text)]"
          >
            <option value="all">All Languages ({packs.length})</option>
            {allLanguages.map((lang) => {
              const cnt = packs.filter((p) => p.languageId === lang.id).length;
              return (
                <option key={lang.id} value={lang.id}>
                  {lang.flagEmoji} {lang.name} ({cnt})
                </option>
              );
            })}
          </select>

          <button
            type="button"
            onClick={handleRunPackCheck}
            disabled={busyAction || isCheckingPacks || packs.length === 0}
            data-testid="pack-check-btn"
            className="min-h-[36px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--border)] disabled:opacity-50 text-xs font-bold text-[var(--text)] inline-flex items-center gap-1.5 transition whitespace-nowrap shrink-0"
          >
            {isCheckingPacks ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Stethoscope className="w-3.5 h-3.5" />
            )}
            <span>
              {isCheckingPacks && packCheckProgress
                ? `Checking ${packCheckProgress.checked}/${packCheckProgress.total}`
                : 'Pack check'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setShowAddForm((prev) => !prev);
              setPendingCsvPreview(null);
            }}
            className="min-h-[36px] px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold inline-flex items-center gap-1.5 transition whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Pack</span>
          </button>

          {confirmRestoreDefaults ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleConfirmRestoreDefaults}
                disabled={busyAction}
                className="min-h-[36px] px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold whitespace-nowrap shrink-0"
              >
                Confirm Restore
              </button>
              <button
                type="button"
                onClick={() => setConfirmRestoreDefaults(false)}
                className="min-h-[36px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRestoreDefaults(true)}
              disabled={busyAction}
              className={`min-h-[36px] px-3 py-1.5 rounded-xl border text-xs font-bold inline-flex items-center gap-1.5 transition whitespace-nowrap shrink-0 ${
                hasCustomizations
                  ? 'border-amber-500/60 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]'
              }`}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Restore Default Packs</span>
            </button>
          )}
        </div>
      </div>

      {/* Feedback message */}
      {statusFeedback && (
        <div
          className={`p-3 rounded-xl border text-xs flex items-center justify-between gap-2 ${
            statusFeedback.type === 'error'
              ? 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300'
              : 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
          }`}
        >
          <div className="flex items-center gap-2">
            {statusFeedback.type === 'error' ? (
              <AlertCircle className="w-4 h-4 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            )}
            <span>{statusFeedback.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusFeedback(null)}
            aria-label="Dismiss status message"
            className="p-0.5 opacity-70 hover:opacity-100"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Pack Check Diagnostic Results Table */}
      {packCheckResults && (
        <div
          data-testid="pack-check-results"
          className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40 overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between gap-2 text-xs">
            <div className="font-bold text-[var(--text)] tabular-nums">
              Pack check results ({packCheckResults.length} tested ·{' '}
              <span className="text-emerald-600 dark:text-emerald-400">
                {packCheckResults.filter((r) => r.status === 'ok').length} ok
              </span>
              {packCheckResults.some((r) => r.status === 'warning') && (
                <>
                  {' · '}
                  <span className="text-amber-600 dark:text-amber-400">
                    {packCheckResults.filter((r) => r.status === 'warning').length} warning
                  </span>
                </>
              )}
              {packCheckResults.some((r) => r.status === 'error') && (
                <>
                  {' · '}
                  <span className="text-rose-600 dark:text-rose-400">
                    {packCheckResults.filter((r) => r.status === 'error').length} error
                  </span>
                </>
              )}
              )
            </div>
            <button
              type="button"
              onClick={() => setPackCheckResults(null)}
              aria-label="Close pack check results"
              className="p-1 text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)]/70 text-[11px] text-[var(--text-muted)] uppercase tracking-wider">
                  <th className="py-2 px-3 font-semibold">pack</th>
                  <th className="py-2 px-3 font-semibold">status</th>
                  <th className="py-2 px-3 font-semibold">detected format</th>
                  <th className="py-2 px-3 font-semibold">rows found</th>
                  <th className="py-2 px-3 font-semibold">problem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {packCheckResults.map((row) => (
                  <tr key={row.packId} className="bg-[var(--surface)]/70">
                    <td className="py-2 px-3">
                      <div className="font-semibold text-[var(--text)]">{row.packTitle}</div>
                      <div className="text-[10px] font-mono text-[var(--text-muted)] truncate max-w-[220px]">
                        {row.filePath}
                      </div>
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap font-bold">
                      {row.status === 'ok' ? (
                        <span className="text-emerald-600 dark:text-emerald-400">OK</span>
                      ) : row.status === 'warning' ? (
                        <span className="text-amber-600 dark:text-amber-400">Warning</span>
                      ) : (
                        <span className="text-rose-600 dark:text-rose-400">Error</span>
                      )}
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap font-mono text-[11px] text-[var(--text-secondary)]">
                      {row.detectedFormat}
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap tabular-nums text-[var(--text)]">
                      {row.rowsFound.toLocaleString()}
                    </td>
                    <td className="py-2 px-3 text-[11px] text-[var(--text-secondary)] max-w-[360px] break-words">
                      {row.problem || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Pack Inline Form */}
      {showAddForm && (
        <div className="p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)]/60 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setAddMode('file');
                  setPendingCsvPreview(null);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 border transition ${
                  addMode === 'file'
                    ? 'border-indigo-500 bg-[var(--surface)] text-[var(--text)]'
                    : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Upload Local File (.json / .json.gz / .csv / .tsv)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setAddMode('url');
                  setPendingCsvPreview(null);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 border transition ${
                  addMode === 'url'
                    ? 'border-indigo-500 bg-[var(--surface)] text-[var(--text)]'
                    : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                <Link2 className="w-3.5 h-3.5" />
                <span>Enter /packs/... Path or URL</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                setShowAddForm(false);
                setPendingCsvPreview(null);
              }}
              aria-label="Close Add Pack form"
              className="p-1 text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
            <label className="space-y-1">
              <span className="font-semibold text-[var(--text-secondary)] block">Language</span>
              <select
                value={newLangId}
                onChange={(e) => setNewLangId(e.target.value)}
                className="w-full min-h-[38px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] font-medium"
              >
                {allLanguages.map((lang) => (
                  <option key={lang.id} value={lang.id}>
                    {lang.flagEmoji} {lang.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="font-semibold text-[var(--text-secondary)] block">
                Pack Category
              </span>
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value as BundledPackCategory)}
                className="w-full min-h-[38px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] font-medium"
              >
                {BUNDLED_PACK_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {BUNDLED_PACK_CATEGORY_LABELS[cat]}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="font-semibold text-[var(--text-secondary)] block">
                Title (Optional)
              </span>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. Custom Core Vocab"
                className="w-full min-h-[38px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
              />
            </label>
          </div>

          {addMode === 'file' ? (
            <div className="space-y-3">
              {!pendingCsvPreview ? (
                <label className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] cursor-pointer hover:border-indigo-500 transition">
                  <div className="space-y-0.5 text-xs">
                    <div className="font-bold text-[var(--text)]">
                      Choose .json, .json.gz, .csv, or .tsv pack file
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)]">
                      Stored offline in IndexedDB and included in this language's "Install All" bundle.
                    </div>
                  </div>
                  <span className="px-3.5 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold shrink-0 text-center">
                    {busyAction ? 'Reading...' : 'Browse File'}
                  </span>
                  <input
                    type="file"
                    accept=".json,.json.gz,.gz,.csv,.tsv"
                    onChange={handleFileUpload}
                    disabled={busyAction}
                    className="hidden"
                  />
                </label>
              ) : (
                /* Quick Column-Mapping Preview when CSV/TSV headers aren't auto-detected */
                <div className="p-3.5 rounded-xl border border-amber-300 dark:border-amber-800 bg-[var(--surface)] space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5 text-xs">
                      <div className="font-bold text-[var(--text)] flex items-center gap-1.5">
                        <Table className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                        <span>
                          Quick Column-Mapping Preview — {pendingCsvPreview.fileName}
                        </span>
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)]">
                        Column headers were not recognized automatically. Map your columns for{' '}
                        <span className="font-semibold text-[var(--text)]">
                          {BUNDLED_PACK_CATEGORY_LABELS[pendingCsvPreview.category]}
                        </span>{' '}
                        ({pendingCsvPreview.table.rows.length.toLocaleString()} rows).
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPendingCsvPreview(null)}
                      className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
                    >
                      Cancel
                    </button>
                  </div>

                  {/* Field mapping dropdowns */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                    {CATEGORY_FIELD_DEFINITIONS[pendingCsvPreview.category].map((field) => (
                      <label key={field.key} className="space-y-1">
                        <span className="font-semibold text-[var(--text-secondary)] block text-[11px]">
                          {field.label}
                          {field.required ? ' *' : ''}
                        </span>
                        <select
                          value={pendingCsvPreview.mapping[field.key] ?? -1}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            setPendingCsvPreview((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    mapping: { ...prev.mapping, [field.key]: val },
                                  }
                                : null
                            );
                          }}
                          className="w-full min-h-[34px] px-2 py-1 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] text-xs"
                        >
                          <option value={-1}>— Not mapped —</option>
                          {pendingCsvPreview.table.headers.map((h, idx) => (
                            <option key={idx} value={idx}>
                              Col {idx + 1}: {h}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>

                  {/* Sample preview rows */}
                  <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                    <table className="w-full text-left text-[11px]">
                      <thead className="bg-[var(--surface-muted)] text-[var(--text-muted)]">
                        <tr>
                          {pendingCsvPreview.table.headers.map((h, i) => (
                            <th key={i} className="px-2.5 py-1.5 font-semibold whitespace-nowrap">
                              Col {i + 1}: {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {pendingCsvPreview.table.rows.slice(0, 4).map((r, rIdx) => (
                          <tr key={rIdx}>
                            {pendingCsvPreview.table.headers.map((_, cIdx) => (
                              <td
                                key={cIdx}
                                className="px-2.5 py-1.5 text-[var(--text)] max-w-[200px] truncate"
                              >
                                {r[cIdx] || '—'}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setPendingCsvPreview(null)}
                      className="min-h-[36px] px-3 py-1.5 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleConfirmCsvMapping}
                      disabled={busyAction}
                      className="min-h-[36px] px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold"
                    >
                      {busyAction ? 'Saving...' : 'Confirm & Add Pack'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleAddUrlSubmit} className="flex flex-col sm:flex-row gap-2 text-xs">
              <input
                type="text"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="/packs/es-common.csv or https://example.com/pack.json.gz"
                className="flex-1 min-h-[38px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] font-mono text-xs"
              />
              <button
                type="submit"
                disabled={busyAction}
                className="min-h-[38px] px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold shrink-0"
              >
                {busyAction ? 'Adding...' : 'Add Pack Path / URL'}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Registry Table */}
      {visiblePacks.length === 0 ? (
        <div className="p-6 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40 text-center space-y-2 text-xs">
          <div className="font-semibold text-[var(--text)]">
            No included packs active for this filter.
          </div>
          <div className="text-[var(--text-muted)]">
            Add a custom pack above or restore the default author pack registry.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)]/70 text-[11px] text-[var(--text-muted)] uppercase tracking-wider">
                <th className="py-2.5 px-3 font-semibold">Pack Title</th>
                <th className="py-2.5 px-3 font-semibold">Language</th>
                <th className="py-2.5 px-3 font-semibold">Category</th>
                <th className="py-2.5 px-3 font-semibold">Source</th>
                <th className="py-2.5 px-3 font-semibold">Status</th>
                <th className="py-2.5 px-3 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {visiblePacks.map((pack) => {
                const lang = getLanguagePack(pack.languageId);
                const installedInfo = installedBundlesMap[pack.id];
                const isConfirming = confirmRemoveId === pack.id;

                return (
                  <React.Fragment key={pack.id}>
                    <tr className="hover:bg-[var(--surface-muted)]/40 transition">
                      <td className="py-2.5 px-3 min-w-[180px]">
                        <div className="font-semibold text-[var(--text)]">{pack.title}</div>
                        {pack.description && (
                          <div className="text-[11px] text-[var(--text-muted)] truncate max-w-[280px]">
                            {pack.description}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap text-[var(--text)]">
                        <span className="mr-1.5" aria-hidden="true">
                          {lang.flagEmoji}
                        </span>
                        <span className="font-medium">{lang.name}</span>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap font-medium text-[var(--text-secondary)]">
                        {BUNDLED_PACK_CATEGORY_LABELS[pack.category]}
                      </td>
                      <td className="py-2.5 px-3 max-w-[220px]">
                        <div
                          className="font-mono text-[11px] text-[var(--text-muted)] truncate"
                          title={pack.url || pack.sourceType}
                        >
                          {pack.url || pack.sourceType}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap text-[11px]">
                        <div className="font-semibold text-emerald-600 dark:text-emerald-400">
                          Active ·{' '}
                          {pack.origin === 'custom'
                            ? 'Custom'
                            : pack.origin === 'auto-discovered'
                            ? 'Auto-discovered'
                            : 'Default'}
                        </div>
                        {installedInfo && (
                          <div className="text-[10px] text-[var(--text-muted)] tabular-nums">
                            {installedInfo.status === 'covered'
                              ? `Covered (${installedInfo.coveredBy || 'Core Dict'})`
                              : `Installed (${installedInfo.entryCount.toLocaleString()} entries)`}
                          </div>
                        )}
                        {installedInfo?.warning && (
                          <div
                            className="text-[10px] text-amber-600 dark:text-amber-400 truncate max-w-[200px]"
                            title={installedInfo.warning}
                          >
                            {installedInfo.warning}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmRemoveId(isConfirming ? null : pack.id);
                            setClearDbOnRemove(Boolean(installedInfo));
                          }}
                          disabled={busyAction}
                          aria-label={`Remove ${pack.title}`}
                          className="px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[11px] font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 inline-flex items-center gap-1 transition"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>Remove</span>
                        </button>
                      </td>
                    </tr>

                    {isConfirming && (
                      <tr className="bg-rose-50/70 dark:bg-rose-950/20">
                        <td colSpan={6} className="px-3 py-2.5">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                            <label className="inline-flex items-center gap-2 text-xs text-[var(--text)] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={clearDbOnRemove}
                                onChange={(e) => setClearDbOnRemove(e.target.checked)}
                                className="rounded border-[var(--border)] text-rose-600 focus:ring-rose-500"
                              />
                              <span>
                                Also clear imported IndexedDB entries for "{pack.title}"
                              </span>
                            </label>
                            <div className="flex items-center gap-2 self-end sm:self-auto">
                              <button
                                type="button"
                                onClick={() => handleConfirmRemove(pack)}
                                disabled={busyAction}
                                className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold"
                              >
                                Confirm Remove
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmRemoveId(null)}
                                className="px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-semibold text-[var(--text-secondary)]"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
