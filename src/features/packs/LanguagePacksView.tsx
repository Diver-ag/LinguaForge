import React, { useState, useEffect } from 'react';
import { getAllLanguagePacks, getLanguagePack } from '../../packs/registry';
import { db, type DownloadedPackAsset } from '../../db/db';
import { useAppStore } from '../../store/useAppStore';
import { logEvent } from '../../core/eventLogger';
import {
  Package,
  CheckCircle2,
  DownloadCloud,
  Trash2,
  RefreshCw,
  HardDrive,
  Layers,
  Award,
  Mic,
  Volume2,
  Camera,
  Check,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';

export const LanguagePacksView: React.FC = () => {
  const { activeLanguageId, setActiveLanguage } = useAppStore();
  const allPacks = getAllLanguagePacks();

  const [downloadedAssets, setDownloadedAssets] = useState<Record<string, DownloadedPackAsset>>({});
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [isDownloading, setIsDownloading] = useState<Record<string, boolean>>({});

  const loadDownloadedAssets = async () => {
    try {
      const items = await db.downloadedAssets.toArray();
      const map: Record<string, DownloadedPackAsset> = {};
      for (const item of items) {
        map[`${item.packId}:${item.assetId}`] = item;
      }
      setDownloadedAssets(map);
    } catch (err) {
      console.error('Failed to load downloaded assets:', err);
    }
  };

  useEffect(() => {
    loadDownloadedAssets();
  }, []);

  const handleDownloadAsset = async (packId: string, asset: any) => {
    const key = `${packId}:${asset.id}`;
    setIsDownloading((prev) => ({ ...prev, [key]: true }));
    setDownloadProgress((prev) => ({ ...prev, [key]: 0 }));

    // Simulate steady network streaming & verification into IndexedDB
    for (let progress = 10; progress <= 100; progress += 15) {
      await new Promise((r) => setTimeout(r, 120));
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
    await loadDownloadedAssets();
  };

  const handleDeleteAsset = async (packId: string, assetId: string) => {
    const key = `${packId}:${assetId}`;
    await db.downloadedAssets.where({ packId, assetId }).delete();
    await logEvent('pack_asset_deleted', { packId, assetId });
    await loadDownloadedAssets();
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col pb-24 md:pb-12">
      {/* Header */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-4 py-6">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Package className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
              <h1 className="text-2xl font-black tracking-tight">Language Packs</h1>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Pluggable offline dictionaries, morphological tokenizers, and level systems
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-semibold border border-emerald-200 dark:border-emerald-800 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              Local-First IndexedDB
            </span>
          </div>
        </div>
      </header>

      {/* Main pack list */}
      <main className="max-w-5xl w-full mx-auto p-4 sm:p-6 space-y-6 flex-1">
        {allPacks.map((pack) => {
          const isActive = pack.id === activeLanguageId;

          return (
            <div
              key={pack.id}
              className={`rounded-3xl border transition-all duration-200 overflow-hidden ${
                isActive
                  ? 'border-indigo-500 bg-white dark:bg-slate-900 shadow-md ring-2 ring-indigo-500/20'
                  : 'border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/60'
              }`}
            >
              {/* Pack Title Bar */}
              <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="text-2xl">{pack.flagEmoji}</span>
                    <h2 className="text-xl font-bold text-slate-900 dark:text-white">
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

              {/* Engine capabilities */}
              <div className="px-6 py-3 bg-slate-50/70 dark:bg-slate-800/30 border-b border-slate-100 dark:border-slate-800 flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-400">
                <div className="flex items-center gap-1.5">
                  <Camera className="w-3.5 h-3.5 text-indigo-500" />
                  <span>OCR: <strong>{pack.ocrCode}</strong></span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Mic className="w-3.5 h-3.5 text-indigo-500" />
                  <span>Speech-to-Text: <strong>{pack.sttCode}</strong></span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Volume2 className="w-3.5 h-3.5 text-indigo-500" />
                  <span>TTS Voice: <strong>{pack.ttsCode}</strong></span>
                </div>
              </div>

              {/* Downloadable Assets */}
              <div className="p-6 space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <HardDrive className="w-4 h-4" />
                  Downloadable Offline Assets ({pack.assetsManifest.length})
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {pack.assetsManifest.map((asset) => {
                    const key = `${pack.id}:${asset.id}`;
                    const isInstalled = !!downloadedAssets[key] || asset.isCoreBundle;
                    const inProgress = isDownloading[key];
                    const progress = downloadProgress[key] || 0;

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
                              {asset.sizeFormatted}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
                            {asset.description}
                          </p>
                          <div className="text-[11px] text-slate-400 flex items-center gap-2 pt-1">
                            <span>v{asset.version}</span>
                            {asset.isCoreBundle && (
                              <span className="text-indigo-600 dark:text-indigo-400 font-medium">
                                • Bundled in App
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Download progress bar */}
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

                        {/* Action buttons */}
                        <div className="flex items-center justify-between pt-1">
                          {isInstalled ? (
                            <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                              <Check className="w-4 h-4" />
                              Ready Offline
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">Available for download</span>
                          )}

                          <div className="flex items-center gap-1.5">
                            {!isInstalled ? (
                              <button
                                onClick={() => handleDownloadAsset(pack.id, asset)}
                                disabled={inProgress}
                                className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold transition shadow-sm"
                              >
                                <DownloadCloud className="w-3.5 h-3.5" />
                                Download Pack
                              </button>
                            ) : !asset.isCoreBundle ? (
                              <button
                                onClick={() => handleDeleteAsset(pack.id, asset.id)}
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
      </main>
    </div>
  );
};
