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
  importCustomLanguageFile,
  installLanguagePack,
  isAbortError,
  removeLanguagePack,
  toggleLanguageSubpack,
  type CloudPackManifest,
  type PackInstallProgress,
} from '../../core/packManager';
import {
  BUNDLED_PACK_CATEGORY_LABELS,
  getEffectiveBundledPacks,
  getInstalledBundledPacksMap,
  installAllAvailableLanguagePacks,
  installAllIncludedPacksForLanguage,
  type AllLanguagesBundleInstallProgress,
  type BundledPackDefinition,
  type InstalledBundledPackStatus,
  type LanguageBundleInstallProgress,
} from '../../core/bundledPacks';
import { DeveloperPackRegistryPanel } from './DeveloperPackRegistryPanel';
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
  ArrowLeftRight,
  Plus,
  Minus,
  Layers,
} from 'lucide-react';

export interface LanguagePackManagerGridProps {
  developerMode: boolean;
  onPacksChanged?: () => void;
  compact?: boolean;
}

const SHORT_CATEGORY_NAMES: Record<string, string> = {
  'core-dict': 'Core Dict',
  'common-dict': 'Common Dict',
  'kanji-levels': 'Kanji Levels',
  examples: 'Examples',
  frequency: 'Frequency',
};

export const LanguagePackManagerGrid: React.FC<LanguagePackManagerGridProps> = ({
  developerMode,
  onPacksChanged,
  compact = false,
}) => {
  const { activeLanguageId, setActiveLanguage, refreshInstalledLanguages } = useAppStore();
  const allPacks = getAllLanguagePacks();

  const [installedMap, setInstalledMap] = useState<Record<string, InstalledLanguagePackRecord>>({});
  const [downloadedAssetsMap, setDownloadedAssetsMap] = useState<Record<string, DownloadedPackAsset[]>>({});
  const [bundledPacks, setBundledPacks] = useState<BundledPackDefinition[]>([]);
  const [removedDefaultIds, setRemovedDefaultIds] = useState<string[]>([]);
  const [installedBundlesMap, setInstalledBundlesMap] = useState<
    Record<string, InstalledBundledPackStatus>
  >({});
  const [isLoading, setIsLoading] = useState(true);
  const [manifestData, setManifestData] = useState<CloudPackManifest | null>(null);

  // Per-pack download / bundle progress, abort controllers, errors, confirmations
  const [progressByLang, setProgressByLang] = useState<Record<string, PackInstallProgress | null>>({});
  const [bundleProgressByLang, setBundleProgressByLang] = useState<
    Record<string, LanguageBundleInstallProgress | null>
  >({});
  const [errorByLang, setErrorByLang] = useState<Record<string, string | null>>({});
  const [confirmRemoveLang, setConfirmRemoveLang] = useState<string | null>(null);
  const [removingLang, setRemovingLang] = useState<string | null>(null);
  const abortControllersRef = useRef<Record<string, AbortController>>({});

  // Global "Install All Available Language Packs" state
  const [batchAllProgress, setBatchAllProgress] =
    useState<AllLanguagesBundleInstallProgress | null>(null);
  const [batchAllError, setBatchAllError] = useState<string | null>(null);
  const [batchAllNotice, setBatchAllNotice] = useState<string | null>(null);
  const batchAllAbortRef = useRef<AbortController | null>(null);

  // Developer drawer state
  const [expandedDevLang, setExpandedDevLang] = useState<Record<string, boolean>>({});
  const [devEntryCounts, setDevEntryCounts] = useState<Record<string, number>>({});
  const [devStatusMsg, setDevStatusMsg] = useState<Record<string, string | null>>({});

  const loadPackStates = useCallback(
    async (fetchRemoteManifest = false) => {
      try {
        const [map, allAssets, effectiveBundle, installedBundles] = await Promise.all([
          getInstalledPacksMap(),
          db.downloadedAssets.toArray().catch(() => [] as DownloadedPackAsset[]),
          getEffectiveBundledPacks({ skipRemoteManifest: !fetchRemoteManifest }),
          getInstalledBundledPacksMap(),
        ]);
        setInstalledMap(map);
        setBundledPacks(effectiveBundle.packs);
        setRemovedDefaultIds(effectiveBundle.removedDefaultIds);
        setInstalledBundlesMap(installedBundles);

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
          const remote = await fetchCloudPackManifest(DEFAULT_PACK_MANIFEST_URL).catch(() => null);
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
      batchAllAbortRef.current?.abort();
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

  const handleInstallLanguageBundle = async (
    langId: string,
    mode: 'auto' | 'cloud-strict' | 'starter' = 'auto'
  ) => {
    const existingCtrl = abortControllersRef.current[langId];
    if (existingCtrl) existingCtrl.abort();

    const controller = new AbortController();
    abortControllersRef.current[langId] = controller;

    const langBundles = bundledPacks.filter((p) => p.languageId === langId);
    const firstPack = langBundles[0];
    setErrorByLang((prev) => ({ ...prev, [langId]: null }));
    if (firstPack) {
      setBundleProgressByLang((prev) => ({
        ...prev,
        [langId]: {
          languageId: langId,
          currentIndex: 1,
          totalCount: langBundles.length,
          currentPack: firstPack,
          percent: 4,
          stage: `Installing 1 of ${langBundles.length}: ${firstPack.title}...`,
        },
      }));
    }

    try {
      await installAllIncludedPacksForLanguage(langId, {
        signal: controller.signal,
        mode,
        onProgress: (prog) => {
          setBundleProgressByLang((prev) => ({ ...prev, [langId]: prog }));
        },
      });

      await refreshInstalledLanguages();
      await loadPackStates(false);
      onPacksChanged?.();
      setBundleProgressByLang((prev) => ({ ...prev, [langId]: null }));
    } catch (err: any) {
      setBundleProgressByLang((prev) => ({ ...prev, [langId]: null }));
      if (!isAbortError(err)) {
        setErrorByLang((prev) => ({
          ...prev,
          [langId]: err?.message || 'Bundle installation failed. Please retry.',
        }));
      }
    } finally {
      delete abortControllersRef.current[langId];
    }
  };

  const handleInstallAllAvailableLanguages = async () => {
    if (batchAllAbortRef.current) batchAllAbortRef.current.abort();
    const controller = new AbortController();
    batchAllAbortRef.current = controller;

    setBatchAllError(null);
    setBatchAllNotice(null);

    const firstLangPack = allPacks.find((p) =>
      bundledPacks.some((bp) => bp.languageId === p.id)
    );
    const firstBundle = firstLangPack
      ? bundledPacks.find((bp) => bp.languageId === firstLangPack.id)
      : undefined;

    if (firstLangPack && firstBundle) {
      setBatchAllProgress({
        languageIndex: 1,
        totalLanguages: allPacks.length,
        currentLanguageId: firstLangPack.id,
        languageProgress: {
          languageId: firstLangPack.id,
          currentIndex: 1,
          totalCount: 1,
          currentPack: firstBundle,
          percent: 3,
          stage: `Installing 1 of 1: ${firstBundle.title}...`,
        },
        overallPercent: 3,
        stage: `[1/${allPacks.length} ${firstLangPack.name}] Installing ${firstBundle.title}...`,
      });
    }

    try {
      const res = await installAllAvailableLanguagePacks({
        signal: controller.signal,
        mode: 'auto',
        onProgress: (prog) => {
          setBatchAllProgress(prog);
        },
      });
      await refreshInstalledLanguages();
      await loadPackStates(false);
      onPacksChanged?.();
      setBatchAllProgress(null);
      setBatchAllNotice(
        `Installed ${res.totalPacksInstalled} packs across ${res.languagesInstalled.length} languages (${res.totalEntries.toLocaleString()} entries).`
      );
    } catch (err: any) {
      setBatchAllProgress(null);
      if (!isAbortError(err)) {
        setBatchAllError(err?.message || 'Batch installation failed. Please retry.');
      }
    } finally {
      batchAllAbortRef.current = null;
    }
  };

  const handleCancelBatchAll = () => {
    batchAllAbortRef.current?.abort();
    batchAllAbortRef.current = null;
    setBatchAllProgress(null);
  };

  const handleCancelDownload = (langId: string) => {
    const ctrl = abortControllersRef.current[langId];
    if (ctrl) {
      ctrl.abort();
      delete abortControllersRef.current[langId];
    }
    setProgressByLang((prev) => ({ ...prev, [langId]: null }));
    setBundleProgressByLang((prev) => ({ ...prev, [langId]: null }));
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

  const installedLangCount = Object.keys(installedMap).length;
  const anyLanguageBusy =
    Boolean(batchAllProgress) ||
    Object.values(progressByLang).some(Boolean) ||
    Object.values(bundleProgressByLang).some(Boolean);

  return (
    <div className="space-y-4">
      {/* Top-Level One-Click Bundle Action Bar */}
      {!isLoading && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)]/45 p-3.5 space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-[var(--text-secondary)] tabular-nums">
              <span className="font-bold text-[var(--text)]">
                {installedLangCount} / {allPacks.length} languages installed
              </span>{' '}
              <span aria-hidden="true">·</span>{' '}
              <span>{bundledPacks.length} included packs ready</span>
            </div>

            {batchAllProgress ? (
              <button
                type="button"
                onClick={handleCancelBatchAll}
                className="min-h-[38px] px-3.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--border)] text-xs font-bold text-[var(--text)] inline-flex items-center justify-center gap-1.5 shrink-0 transition"
              >
                <X className="w-3.5 h-3.5" />
                <span>Cancel Batch Install</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleInstallAllAvailableLanguages}
                disabled={anyLanguageBusy || bundledPacks.length === 0}
                data-testid="install-all-languages-btn"
                className="min-h-[38px] px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold inline-flex items-center justify-center gap-1.5 shadow-xs shrink-0 transition active:scale-[0.99]"
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Install All Available Language Packs</span>
              </button>
            )}
          </div>

          {batchAllProgress && (
            <div className="space-y-1 pt-0.5">
              <div className="w-full h-1.5 rounded-full bg-[var(--surface)] overflow-hidden">
                <div
                  className="h-full bg-indigo-600 transition-all duration-150"
                  style={{ width: `${Math.max(4, Math.min(100, batchAllProgress.overallPercent))}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] gap-2">
                <span className="truncate">{batchAllProgress.stage}</span>
                <span className="font-mono tabular-nums shrink-0">
                  {batchAllProgress.overallPercent}%
                </span>
              </div>
            </div>
          )}

          {batchAllNotice && (
            <div className="flex items-center justify-between gap-2 text-[11px] text-emerald-700 dark:text-emerald-300 font-medium">
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                {batchAllNotice}
              </span>
              <button
                type="button"
                onClick={() => setBatchAllNotice(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text)]"
                aria-label="Dismiss notification"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {batchAllError && (
            <div className="flex items-center justify-between gap-2 text-[11px] text-rose-700 dark:text-rose-300 font-medium">
              <span className="inline-flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                {batchAllError}
              </span>
              <button
                type="button"
                onClick={() => setBatchAllError(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text)]"
                aria-label="Dismiss error"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Clean Language Grid */}
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
            const singleProgress = progressByLang[pack.id];
            const bundleProgress = bundleProgressByLang[pack.id];
            const activeProgress = bundleProgress
              ? { percent: bundleProgress.percent, stage: bundleProgress.stage }
              : singleProgress;
            const errorMsg = errorByLang[pack.id];
            const isConfirmingRemove = confirmRemoveLang === pack.id;
            const isRemoving = removingLang === pack.id;
            const devOpen = Boolean(expandedDevLang[pack.id]);

            const langBundledPacks = bundledPacks.filter((bp) => bp.languageId === pack.id);
            const installedSubCount = langBundledPacks.filter((bp) =>
              Boolean(installedBundlesMap[bp.id])
            ).length;
            const uninstalledSubCount = langBundledPacks.length - installedSubCount;
            const categorySummary = langBundledPacks
              .map((bp) => SHORT_CATEGORY_NAMES[bp.category] || BUNDLED_PACK_CATEGORY_LABELS[bp.category])
              .filter((v, idx, arr) => arr.indexOf(v) === idx)
              .join(', ');

            const byteSize = manifestItem?.sizeBytes ?? installed?.sizeBytes ?? pack.packSizeBytes;
            const displaySize =
              byteSize && byteSize > 0
                ? formatPackBytes(byteSize)
                : pack.packSizeFormatted || '5.0 MB';

            const statusText = activeProgress
              ? `Installing · ${activeProgress.percent}%`
              : updateAvailable
              ? 'Update Available'
              : isInstalled
              ? 'Installed'
              : 'Not Installed';

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
                        activeProgress
                          ? 'text-indigo-600 dark:text-indigo-400'
                          : updateAvailable
                          ? 'text-amber-600 dark:text-amber-400'
                          : isInstalled
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {isInstalled && !activeProgress && !updateAvailable && (
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <span>{statusText}</span>
                    </span>
                    <span aria-hidden="true" className="text-[var(--text-muted)]">
                      ·
                    </span>
                    <span className="text-[var(--text-muted)]">{displaySize}</span>
                  </div>

                  {/* Clean Included Packs Summary */}
                  <div className="text-[11px] text-[var(--text-muted)] tabular-nums leading-snug">
                    {langBundledPacks.length > 0 ? (
                      <span>
                        <span className="font-semibold text-[var(--text-secondary)]">
                          {langBundledPacks.length} included{' '}
                          {langBundledPacks.length === 1 ? 'pack' : 'packs'}:
                        </span>{' '}
                        {categorySummary}
                      </span>
                    ) : (
                      <span>No included packs configured</span>
                    )}
                  </div>

                  {/* Unified Streaming / Sequential Bundle Progress Bar */}
                  {activeProgress && (
                    <div className="space-y-1 pt-1">
                      <div className="w-full h-1.5 rounded-full bg-[var(--surface-muted)] overflow-hidden">
                        <div
                          className="h-full bg-indigo-600 transition-all duration-150"
                          style={{
                            width: `${Math.max(4, Math.min(100, activeProgress.percent))}%`,
                          }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] gap-2">
                        <span className="truncate">{activeProgress.stage}</span>
                        <span className="font-mono tabular-nums shrink-0">
                          {activeProgress.percent}%
                        </span>
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
                          onClick={() =>
                            langBundledPacks.length > 0
                              ? handleInstallLanguageBundle(pack.id, 'auto')
                              : handleDownloadOrUpdate(pack.id, 'cloud-strict')
                          }
                          className="underline"
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            langBundledPacks.length > 0
                              ? handleInstallLanguageBundle(pack.id, 'starter')
                              : handleDownloadOrUpdate(pack.id, 'starter')
                          }
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
                  {activeProgress ? (
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
                    langBundledPacks.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => handleInstallLanguageBundle(pack.id, 'auto')}
                        disabled={Boolean(batchAllProgress)}
                        data-testid={`install-all-included-${pack.id}`}
                        className="w-full min-h-[40px] px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold inline-flex items-center justify-center gap-1.5 shadow-xs transition active:scale-[0.99] tabular-nums"
                      >
                        <DownloadCloud className="w-4 h-4 shrink-0" />
                        <span>Install All Included Packs ({langBundledPacks.length})</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleDownloadOrUpdate(pack.id, 'cloud-strict')}
                        disabled={Boolean(batchAllProgress)}
                        className="w-full min-h-[40px] px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold inline-flex items-center justify-center gap-1.5 shadow-xs transition active:scale-[0.99]"
                      >
                        <DownloadCloud className="w-4 h-4" />
                        <span>Download Pack</span>
                      </button>
                    )
                  ) : (
                    <>
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

                      {uninstalledSubCount > 0 && langBundledPacks.length > 0 && (
                        <button
                          type="button"
                          onClick={() => handleInstallLanguageBundle(pack.id, 'auto')}
                          disabled={Boolean(batchAllProgress)}
                          data-testid={`install-all-included-${pack.id}`}
                          className="w-full min-h-[36px] px-3 py-1.5 rounded-xl border border-indigo-300 dark:border-indigo-700/70 bg-[var(--accent-subtle)] hover:bg-indigo-100 dark:hover:bg-indigo-950/50 text-[var(--accent-text)] text-xs font-bold inline-flex items-center justify-center gap-1.5 transition tabular-nums"
                        >
                          <DownloadCloud className="w-3.5 h-3.5 shrink-0" />
                          <span>
                            Install All Included Packs ({langBundledPacks.length})
                          </span>
                        </button>
                      )}
                    </>
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

      {/* Developer Options: Included Packs Registry (Add, Remove, Restore Defaults) */}
      {!isLoading && developerMode && (
        <DeveloperPackRegistryPanel
          packs={bundledPacks}
          removedDefaultIds={removedDefaultIds}
          installedBundlesMap={installedBundlesMap}
          onRegistryChanged={() => loadPackStates(false)}
        />
      )}
    </div>
  );
};

