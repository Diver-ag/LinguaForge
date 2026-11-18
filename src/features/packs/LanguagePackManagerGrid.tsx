import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getAllLanguagePacks } from '../../packs/registry';
import { formatPackBytes } from '../../core/languagePack';
import { db, type DownloadedPackAsset, type InstalledLanguagePackRecord } from '../../db/db';
import { useAppStore } from '../../store/useAppStore';
import {
  DEFAULT_PACK_MANIFEST_URL,
  checkPackUpdateAvailable,
  clearLanguagePackCache,
  fetchCloudPackManifest,
  getInstalledPacksMap,
  getPackManifestUrl,
  importCustomLanguageFile,
  installLanguagePack,
  isAbortError,
  removeLanguagePack,
  resolveManifestPackUrl,
  setPackManifestUrl,
  toggleLanguageSubpack,
  type CloudPackManifest,
  type PackInstallProgress,
} from '../../core/packManager';
import {
  CheckCircle2,
  DownloadCloud,
  Trash2,
  X,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Upload,
  AlertCircle,
  Loader2,
  SlidersHorizontal,
  ArrowLeftRight,
  Plus,
  Minus,
} from 'lucide-react';

export interface LanguagePackManagerGridProps {
  developerMode: boolean;
  onPacksChanged?: () => void;
  compact?: boolean;
}

export const LanguagePackManagerGrid: React.FC<LanguagePackManagerGridProps> = ({
  developerMode,
  onPacksChanged,
  compact = false,
}) => {
  const { activeLanguageId, setActiveLanguage, refreshInstalledLanguages } = useAppStore();
  const allPacks = getAllLanguagePacks();

  const [installedMap, setInstalledMap] = useState<Record<string, InstalledLanguagePackRecord>>({});
  const [downloadedAssetsMap, setDownloadedAssetsMap] = useState<Record<string, DownloadedPackAsset[]>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [manifestUrl, setManifestUrlInput] = useState(DEFAULT_PACK_MANIFEST_URL);
  const [manifestData, setManifestData] = useState<CloudPackManifest | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);

  // Per-pack download progress, abort controllers, errors, confirmations
  const [progressByLang, setProgressByLang] = useState<Record<string, PackInstallProgress | null>>({});
  const [errorByLang, setErrorByLang] = useState<Record<string, string | null>>({});
  const [confirmRemoveLang, setConfirmRemoveLang] = useState<string | null>(null);
  const [removingLang, setRemovingLang] = useState<string | null>(null);
  const abortControllersRef = useRef<Record<string, AbortController>>({});

  // Developer drawer state
  const [expandedDevLang, setExpandedDevLang] = useState<Record<string, boolean>>({});
  const [devEntryCounts, setDevEntryCounts] = useState<Record<string, number>>({});
  const [devStatusMsg, setDevStatusMsg] = useState<Record<string, string | null>>({});
  const [manifestSavedToast, setManifestSavedToast] = useState(false);

  const loadPackStates = useCallback(
    async (fetchRemoteManifest = false) => {
      try {
        const [map, url, allAssets] = await Promise.all([
          getInstalledPacksMap(),
          getPackManifestUrl(),
          db.downloadedAssets.toArray().catch(() => [] as DownloadedPackAsset[]),
        ]);
        setInstalledMap(map);
        setManifestUrlInput(url);

        const groupedAssets: Record<string, DownloadedPackAsset[]> = {};
        for (const a of allAssets) {
          if (!groupedAssets[a.packId]) groupedAssets[a.packId] = [];
          groupedAssets[a.packId].push(a);
        }
        setDownloadedAssetsMap(groupedAssets);

        if (developerMode) {
          const counts: Record<string, number> = {};
          for (const p of getAllLanguagePacks()) {
            counts[p.id] = await db.jmdictEntries.where('languageCode').equals(p.id).count().catch(() => 0);
          }
          setDevEntryCounts(counts);
        }

        if (fetchRemoteManifest) {
          const remote = await fetchCloudPackManifest(url).catch(() => null);
          if (remote) {
            setManifestData(remote);
          }
        }
      } finally {
        setIsLoading(false);
      }
    },
    [developerMode]
  );

  useEffect(() => {
    loadPackStates(true);
    return () => {
      Object.values(abortControllersRef.current).forEach((ctrl) => ctrl.abort());
    };
  }, [loadPackStates]);

  const handleDownloadOrUpdate = async (
    langId: string,
    mode: 'cloud-strict' | 'starter' = 'cloud-strict'
  ) => {
    const existingCtrl = abortControllersRef.current[langId];
    if (existingCtrl) existingCtrl.abort();

    const controller = new AbortController();
    abortControllersRef.current[langId] = controller;

    setErrorByLang((prev) => ({ ...prev, [langId]: null }));
    setProgressByLang((prev) => ({
      ...prev,
      [langId]: {
        percent: 4,
        stage: mode === 'starter' ? 'Installing offline starter...' : 'Starting cloud download...',
      },
    }));

    try {
      await installLanguagePack(langId, {
        signal: controller.signal,
        mode,
        manifestUrl,
        onProgress: (prog) => {
          setProgressByLang((prev) => ({ ...prev, [langId]: prog }));
        },
      });

      await refreshInstalledLanguages();
      await loadPackStates(false);
      onPacksChanged?.();
      setProgressByLang((prev) => ({ ...prev, [langId]: null }));
    } catch (err: any) {
      setProgressByLang((prev) => ({ ...prev, [langId]: null }));
      if (!isAbortError(err)) {
        setErrorByLang((prev) => ({
          ...prev,
          [langId]: err?.message || 'Download failed. Please retry.',
        }));
      }
    } finally {
      delete abortControllersRef.current[langId];
    }
  };

  const handleCancelDownload = (langId: string) => {
    const ctrl = abortControllersRef.current[langId];
    if (ctrl) {
      ctrl.abort();
      delete abortControllersRef.current[langId];
    }
    setProgressByLang((prev) => ({ ...prev, [langId]: null }));
  };

  const handleRemovePack = async (langId: string) => {
    setRemovingLang(langId);
    setConfirmRemoveLang(null);
    setErrorByLang((prev) => ({ ...prev, [langId]: null }));
    try {
      await removeLanguagePack(langId);
      if (activeLanguageId === langId) {
        const remaining = await getInstalledPacksMap();
        const fallbackId =
          Object.keys(remaining).find((id) => id !== langId) ||
          (langId !== 'ja' ? 'ja' : 'de');
        if (remaining[fallbackId]) {
          await setActiveLanguage(fallbackId);
        }
      }
      await refreshInstalledLanguages();
      await loadPackStates(false);
      onPacksChanged?.();
    } catch (err: any) {
      setErrorByLang((prev) => ({
        ...prev,
        [langId]: err?.message || 'Failed to remove language pack.',
      }));
    } finally {
      setRemovingLang(null);
    }
  };

  const handleSwitchLanguage = async (langId: string) => {
    await setActiveLanguage(langId);
  };

  const handleSaveManifestAndCheck = async () => {
    setIsCheckingUpdates(true);
    try {
      const saved = await setPackManifestUrl(manifestUrl);
      setManifestUrlInput(saved);
      const manifest = await fetchCloudPackManifest(saved);
      setManifestData(manifest);
      setManifestSavedToast(true);
      setTimeout(() => setManifestSavedToast(false), 2500);
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  const handleCustomImport = async (
    langId: string,
    kind: 'dictionary' | 'frequency',
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setDevStatusMsg((prev) => ({ ...prev, [langId]: `Importing ${file.name}...` }));
    try {
      const res = await importCustomLanguageFile(langId, file, kind);
      await loadPackStates(false);
      await refreshInstalledLanguages();
      onPacksChanged?.();
      setDevStatusMsg((prev) => ({
        ...prev,
        [langId]: `Imported ${res.importedCount.toLocaleString()} ${kind} entries from ${file.name}.`,
      }));
    } catch (err: any) {
      setDevStatusMsg((prev) => ({
        ...prev,
        [langId]: `Error: ${err?.message || 'Failed to parse file'}`,
      }));
    }
  };

  const handleToggleSubpack = async (langId: string, assetId: string, currentlyAdded: boolean) => {
    await toggleLanguageSubpack(langId, assetId, currentlyAdded ? 'remove' : 'add');
    await loadPackStates(false);
    await refreshInstalledLanguages();
    onPacksChanged?.();
    setDevStatusMsg((prev) => ({
      ...prev,
      [langId]: currentlyAdded ? `Removed sub-pack (${assetId}).` : `Added sub-pack (${assetId}).`,
    }));
  };

  const handleClearCache = async (langId: string) => {
    await clearLanguagePackCache(langId);
    await loadPackStates(false);
    setDevStatusMsg((prev) => ({
      ...prev,
      [langId]: 'Pack asset cache cleared.',
    }));
  };

  return (
    <div className="space-y-4">
      {/* Developer-only Manifest Endpoint bar */}
      {developerMode && (
        <div className="p-4 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)]/60 space-y-2.5 text-xs">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="font-bold text-[var(--text)] flex items-center gap-1.5">
              <SlidersHorizontal className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
              <span>Developer: Cloud Pack Manifest URL</span>
            </div>
            {manifestSavedToast && (
              <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                {manifestData
                  ? `Manifest synced (${Object.keys(manifestData.packs || {}).length} packs)`
                  : 'URL saved (manifest unreachable — offline starter fallback ready)'}
              </span>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="url"
              value={manifestUrl}
              onChange={(e) => setManifestUrlInput(e.target.value)}
              placeholder={DEFAULT_PACK_MANIFEST_URL}
              className="flex-1 min-h-[38px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] font-mono text-xs"
            />
            <button
              type="button"
              onClick={handleSaveManifestAndCheck}
              disabled={isCheckingUpdates}
              className="min-h-[38px] px-3.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--border)] font-bold text-[var(--text)] inline-flex items-center justify-center gap-1.5 shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isCheckingUpdates ? 'animate-spin' : ''}`} />
              <span>Save &amp; Check Updates</span>
            </button>
          </div>
        </div>
      )}

      {/* Clean 9-Language Grid */}
      {isLoading ? (
        <div className="py-10 flex items-center justify-center gap-2 text-xs text-[var(--text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin text-indigo-600 dark:text-indigo-400" />
          <span>Loading language packs...</span>
        </div>
      ) : (
        <div
          className={`grid gap-3.5 ${
            compact ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
          }`}
        >
          {allPacks.map((pack) => {
            const installed = installedMap[pack.id];
            const isInstalled = Boolean(installed);
            const manifestItem = manifestData?.packs?.[pack.id];
            const updateAvailable = checkPackUpdateAvailable(installed, manifestItem?.version);
            const isActive = activeLanguageId === pack.id;
            const progress = progressByLang[pack.id];
            const errorMsg = errorByLang[pack.id];
            const isConfirmingRemove = confirmRemoveLang === pack.id;
            const isRemoving = removingLang === pack.id;
            const devOpen = Boolean(expandedDevLang[pack.id]);

            const byteSize = manifestItem?.sizeBytes ?? installed?.sizeBytes ?? pack.packSizeBytes;
            const displaySize =
              byteSize && byteSize > 0
                ? formatPackBytes(byteSize)
                : pack.packSizeFormatted || '5.0 MB';

            const statusText = progress
              ? `Downloading · ${progress.percent}%`
              : updateAvailable
              ? 'Update Available'
              : isInstalled
              ? 'Installed'
              : 'Not Installed';

            const resolvedPackUrl = resolveManifestPackUrl(manifestItem, manifestUrl);
            const installedAssetsForPack = downloadedAssetsMap[pack.id] || [];
            const installedSubpackIds = new Set<string>([
              ...(installed?.subpacks || []),
              ...installedAssetsForPack.map((a) => a.assetId),
            ]);

            return (
              <div
                key={pack.id}
                data-testid={`pack-card-${pack.id}`}
                className={`rounded-2xl border p-4 bg-[var(--surface)] flex flex-col justify-between gap-4 transition ${
                  isActive
                    ? 'border-indigo-500 ring-1 ring-indigo-500/25'
                    : 'border-[var(--border)]'
                }`}
              >
                {/* Clean Default Header: Flag, English + Native Name, Status Badge · Size */}
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-2xl leading-none shrink-0" aria-hidden="true">
                        {pack.flagEmoji}
                      </span>
                      <div className="min-w-0">
                        <div className="font-bold text-sm text-[var(--text)] truncate">
                          {pack.name}
                        </div>
                        <div className="text-xs text-[var(--text-muted)] truncate">
                          {pack.nativeName}
                        </div>
                      </div>
                    </div>

                    {isActive && (
                      <span className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 shrink-0">
                        Active
                      </span>
                    )}
                  </div>

                  {/* Clean Status Badge + Size */}
                  <div className="flex items-center gap-1.5 text-xs tabular-nums">
                    <span
                      className={`inline-flex items-center gap-1 font-semibold ${
                        progress
                          ? 'text-indigo-600 dark:text-indigo-400'
                          : updateAvailable
                          ? 'text-amber-600 dark:text-amber-400'
                          : isInstalled
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {isInstalled && !progress && !updateAvailable && (
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <span>{statusText}</span>
                    </span>
                    <span aria-hidden="true" className="text-[var(--text-muted)]">
                      ·
                    </span>
                    <span className="text-[var(--text-muted)]">{displaySize}</span>
                  </div>

                  {/* Streaming Download Progress Bar */}
                  {progress && (
                    <div className="space-y-1 pt-1">
                      <div className="w-full h-1.5 rounded-full bg-[var(--surface-muted)] overflow-hidden">
                        <div
                          className="h-full bg-indigo-600 transition-all duration-150"
                          style={{ width: `${Math.max(4, Math.min(100, progress.percent))}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] gap-2">
                        <span className="truncate">{progress.stage}</span>
                        <span className="font-mono tabular-nums shrink-0">{progress.percent}%</span>
                      </div>
                    </div>
                  )}

                  {/* Clear Error + Retry (+ Offline Starter option) */}
                  {errorMsg && (
                    <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-[11px] text-rose-700 dark:text-rose-300 space-y-2">
                      <div className="flex items-start gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span className="leading-snug">{errorMsg}</span>
                      </div>
                      <div className="flex items-center gap-3 font-bold">
                        <button
                          type="button"
                          onClick={() => handleDownloadOrUpdate(pack.id, 'cloud-strict')}
                          className="underline"
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDownloadOrUpdate(pack.id, 'starter')}
                          className="underline text-rose-800 dark:text-rose-200"
                        >
                          Use Offline Starter
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Primary Action Row */}
                <div className="space-y-2">
                  {progress ? (
                    <button
                      type="button"
                      onClick={() => handleCancelDownload(pack.id)}
                      className="w-full min-h-[40px] px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--border)] text-xs font-bold text-[var(--text)] inline-flex items-center justify-center gap-1.5 transition"
                    >
                      <X className="w-3.5 h-3.5" />
                      <span>Cancel</span>
                    </button>
                  ) : isConfirmingRemove ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleRemovePack(pack.id)}
                        disabled={isRemoving}
                        className="flex-1 min-h-[40px] px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition"
                      >
                        Confirm Remove
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveLang(null)}
                        className="min-h-[40px] px-3 py-2 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)]"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : !isInstalled ? (
                    <button
                      type="button"
                      onClick={() => handleDownloadOrUpdate(pack.id, 'cloud-strict')}
                      className="w-full min-h-[40px] px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold inline-flex items-center justify-center gap-1.5 shadow-xs transition active:scale-[0.99]"
                    >
                      <DownloadCloud className="w-4 h-4" />
                      <span>Download Pack</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      {updateAvailable ? (
                        <button
                          type="button"
                          onClick={() => handleDownloadOrUpdate(pack.id, 'cloud-strict')}
                          className="flex-1 min-h-[40px] px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold inline-flex items-center justify-center gap-1.5 transition"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>Update Pack</span>
                        </button>
                      ) : isActive ? (
                        <div className="flex-1 min-h-[40px] px-3.5 py-2 rounded-xl bg-[var(--accent-subtle)] text-[var(--accent-text)] border border-indigo-500/30 text-xs font-bold inline-flex items-center justify-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Active</span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleSwitchLanguage(pack.id)}
                          className="flex-1 min-h-[40px] px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold inline-flex items-center justify-center gap-1.5 transition"
                        >
                          <ArrowLeftRight className="w-3.5 h-3.5" />
                          <span>Switch</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setConfirmRemoveLang(pack.id)}
                        disabled={isRemoving}
                        aria-label={`Remove ${pack.name} pack`}
                        title={`Remove ${pack.name} pack (keeps flashcards & history)`}
                        className="min-h-[40px] px-3 py-2 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)] hover:text-rose-600 hover:border-rose-300 dark:hover:border-rose-800 inline-flex items-center justify-center gap-1 transition"
                      >
                        {isRemoving ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <>
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Remove</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}

                  {/* Strictly gated Developer Options drawer */}
                  {developerMode && (
                    <div className="pt-2 border-t border-[var(--border)]/70">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedDevLang((prev) => ({
                            ...prev,
                            [pack.id]: !prev[pack.id],
                          }))
                        }
                        className="w-full py-1.5 text-[11px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text)] flex items-center justify-between"
                      >
                        <span>Advanced / Sub-packs &amp; Sources</span>
                        {devOpen ? (
                          <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>

                      {devOpen && (
                        <div className="mt-2 p-3 rounded-xl bg-[var(--surface-muted)]/70 border border-[var(--border)] space-y-2.5 text-[11px]">
                          <div className="space-y-1 text-[var(--text-secondary)]">
                            <div>
                              <span className="font-semibold text-[var(--text)]">Tokenizer engine:</span>{' '}
                              {pack.packTokenizerLabel || 'Intl.Segmenter'}
                            </div>
                            <div>
                              <span className="font-semibold text-[var(--text)]">Dictionary source:</span>{' '}
                              {pack.packSourceLabel || 'Bundled'}
                            </div>
                            <div className="tabular-nums">
                              <span className="font-semibold text-[var(--text)]">
                                Entry count:
                              </span>{' '}
                              {(devEntryCounts[pack.id] ?? installed?.entryCount ?? 0).toLocaleString()} indexed
                              {manifestItem?.entryCount ? ` · ${manifestItem.entryCount.toLocaleString()} in manifest` : ''}
                            </div>
                            <div>
                              <span className="font-semibold text-[var(--text)]">Frequency / Level index:</span>{' '}
                              {pack.levelSystem.name} ({pack.levelSystem.levels.map((l) => l.code).join(', ')})
                            </div>
                            {resolvedPackUrl && (
                              <div className="truncate font-mono text-[10px] text-[var(--text-muted)]" title={resolvedPackUrl}>
                                <span className="font-sans font-semibold text-[var(--text)]">Bundle URL:</span>{' '}
                                {resolvedPackUrl}
                              </div>
                            )}
                          </div>

                          <div className="space-y-1.5">
                            <div className="font-semibold text-[var(--text)]">Sub-packs:</div>
                            {pack.assetsManifest.map((asset) => {
                              const hasAsset = installedSubpackIds.has(asset.id);
                              return (
                                <div
                                  key={asset.id}
                                  className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]"
                                >
                                  <span className="truncate">{asset.name} ({asset.sizeFormatted})</span>
                                  <button
                                    type="button"
                                    onClick={() => handleToggleSubpack(pack.id, asset.id, hasAsset)}
                                    className={`px-2 py-0.5 rounded border text-[10px] font-semibold inline-flex items-center gap-0.5 shrink-0 ${
                                      hasAsset
                                        ? 'border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30'
                                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--border)]'
                                    }`}
                                  >
                                    {hasAsset ? (
                                      <>
                                        <Minus className="w-2.5 h-2.5" />
                                        <span>Remove</span>
                                      </>
                                    ) : (
                                      <>
                                        <Plus className="w-2.5 h-2.5" />
                                        <span>Add</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                              );
                            })}
                          </div>

                          <div className="flex flex-wrap gap-1.5 pt-1">
                            <label className="min-h-[32px] px-2.5 py-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--border)] text-[var(--text)] font-semibold inline-flex items-center gap-1 cursor-pointer">
                              <Upload className="w-3 h-3" />
                              <span>Import .json / .json.gz</span>
                              <input
                                type="file"
                                accept=".json,.json.gz,.gz,.csv,.tsv,.txt"
                                onChange={(e) => handleCustomImport(pack.id, 'dictionary', e)}
                                className="hidden"
                              />
                            </label>
                            <label className="min-h-[32px] px-2.5 py-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--border)] text-[var(--text)] font-semibold inline-flex items-center gap-1 cursor-pointer">
                              <Upload className="w-3 h-3" />
                              <span>Import Freq</span>
                              <input
                                type="file"
                                accept=".json,.json.gz,.gz,.csv,.tsv,.txt"
                                onChange={(e) => handleCustomImport(pack.id, 'frequency', e)}
                                className="hidden"
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() => handleClearCache(pack.id)}
                              className="min-h-[32px] px-2.5 py-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--border)] text-[var(--text-secondary)] font-semibold"
                            >
                              Clear Cache
                            </button>
                          </div>

                          {devStatusMsg[pack.id] && (
                            <div className="text-[10px] text-indigo-600 dark:text-indigo-400 font-medium">
                              {devStatusMsg[pack.id]}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
