import React, { useState, useEffect } from 'react';
import { db } from '../../db/db';
import { useAppStore, type AppTheme, type FuriganaMode, type FontSize } from '../../store/useAppStore';
import {
  getStoredApiKey,
  setStoredApiKey,
  getStoredModel,
  setStoredModel,
  fetchAvailableModels,
  DEFAULT_GEMINI_MODEL,
} from '../../ai/gemini';
import { downloadBackupFile, restoreFromBackup } from '../../core/backup';
import { getRecentEvents, clearEventLogs } from '../../core/eventLogger';
import {
  Settings,
  Key,
  Download,
  Upload,
  Sun,
  Moon,
  Monitor,
  Eye,
  Type,
  Palette,
  Activity,
  CheckCircle,
  AlertCircle,
  Trash2,
  RefreshCw,
  ShieldCheck,
  FileJson,
  Loader2,
  Cpu,
} from 'lucide-react';

export const SettingsView: React.FC = () => {
  const {
    theme,
    setTheme,
    furiganaMode,
    setFuriganaMode,
    colorCodingEnabled,
    setColorCodingEnabled,
    fontSize,
    setFontSize,
    geminiModel,
    setGeminiModel,
  } = useAppStore();

  const [apiKey, setApiKey] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [keySavedToast, setKeySavedToast] = useState(false);

  // Gemini Model state
  const [availableModels, setAvailableModels] = useState<string[]>([
    DEFAULT_GEMINI_MODEL,
    'gemini-3.5-flash',
    'gemini-3.7-flash',
    'gemini-3.1-flash-lite',
  ]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [isCustomModel, setIsCustomModel] = useState(false);
  const [customModelInput, setCustomModelInput] = useState('');
  const [modelSavedToast, setModelSavedToast] = useState(false);

  // Backup & Restore
  const [restoreMessage, setRestoreMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);

  // Events log state
  const [eventLogs, setEventLogs] = useState<any[]>([]);
  const [showEventInspector, setShowEventInspector] = useState(false);

  useEffect(() => {
    async function loadData() {
      const key = await getStoredApiKey();
      setApiKey(key);

      const stored = await getStoredModel();
      if (stored) {
        setCustomModelInput(stored);
      }

      if (key) {
        loadModelList(key, stored);
      } else {
        const standardList = [DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.1-flash-lite'];
        setAvailableModels(standardList);
        setIsCustomModel(!standardList.includes(stored));
      }

      const events = await getRecentEvents(50);
      setEventLogs(events);
    }
    loadData();
  }, []);

  const loadModelList = async (keyToUse: string, currentSelectedModel?: string) => {
    if (!keyToUse) return;
    setIsLoadingModels(true);
    setModelsFetchError(null);
    try {
      const models = await fetchAvailableModels(keyToUse);
      setAvailableModels(models);
      const active = currentSelectedModel || geminiModel || DEFAULT_GEMINI_MODEL;
      setIsCustomModel(!models.includes(active));
      setIsLoadingModels(false);
    } catch (err: any) {
      setIsLoadingModels(false);
      setModelsFetchError(err.message || 'Could not load models from Gemini API.');
    }
  };

  const handleSaveApiKey = async () => {
    setIsSavingKey(true);
    await setStoredApiKey(apiKey);
    setIsSavingKey(false);
    setKeySavedToast(true);
    setTimeout(() => setKeySavedToast(false), 2500);

    if (apiKey.trim()) {
      await loadModelList(apiKey.trim(), geminiModel);
    }
  };

  const handleSelectModel = async (selected: string) => {
    if (selected === '__custom__') {
      setIsCustomModel(true);
    } else {
      setIsCustomModel(false);
      await setGeminiModel(selected);
      setModelSavedToast(true);
      setTimeout(() => setModelSavedToast(false), 2000);
    }
  };

  const handleSaveCustomModel = async () => {
    if (!customModelInput.trim()) return;
    await setGeminiModel(customModelInput.trim());
    setModelSavedToast(true);
    setTimeout(() => setModelSavedToast(false), 2000);
  };

  const handleRefreshModels = async () => {
    const key = apiKey || (await getStoredApiKey());
    if (!key) {
      setModelsFetchError('Please save an API key first to query live models.');
      return;
    }
    await loadModelList(key, geminiModel);
  };

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsRestoring(true);
    setRestoreMessage(null);

    try {
      const jsonText = await file.text();
      const result = await restoreFromBackup(jsonText);
      setIsRestoring(false);
      if (result.success) {
        setRestoreMessage({ type: 'success', text: result.message });
      } else {
        setRestoreMessage({ type: 'error', text: result.message });
      }
    } catch (err: any) {
      setIsRestoring(false);
      setRestoreMessage({ type: 'error', text: `Failed to read file: ${err.message}` });
    }
  };

  const handleClearAllData = async () => {
    if (confirm('Warning: This will clear all documents, lookups, and statuses in your local IndexedDB. Are you sure?')) {
      await db.documents.clear();
      await db.lookups.clear();
      await db.wordStatuses.clear();
      await db.flashcards.clear();
      await db.eventLogs.clear();
      alert('All local database tables cleared.');
      window.location.reload();
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col pb-24 md:pb-12">
      {/* Header */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-4 py-6">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-2">
            <Settings className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
            <h1 className="text-2xl font-black tracking-tight">Settings & Local Storage</h1>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Configure appearance, AI enhancement, and full on-device JSON backups
          </p>
        </div>
      </header>

      {/* Main settings container */}
      <main className="max-w-4xl w-full mx-auto p-4 sm:p-6 space-y-6 flex-1">
        {/* Gemini API Key */}
        <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Key className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <h2 className="font-bold text-base text-slate-900 dark:text-white">Gemini API Key (Optional)</h2>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xl leading-relaxed">
                Empowers multi-word phrase translation, nuance breakdown, and contextual AI tutor features.
                Key is stored exclusively in your browser's private IndexedDB.
              </p>
            </div>
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500">
              Client-Side Only
            </span>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="password"
              placeholder="Paste AI Studio API key (AIzaSy...)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/80 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
            />
            <button
              onClick={handleSaveApiKey}
              disabled={isSavingKey}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition shadow-sm shrink-0"
            >
              {isSavingKey ? 'Saving...' : 'Save API Key'}
            </button>
          </div>

          {keySavedToast && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-semibold animate-in fade-in">
              <CheckCircle className="w-4 h-4" />
              <span>API key securely stored in IndexedDB!</span>
            </div>
          )}

          <hr className="border-slate-100 dark:border-slate-800/80 my-1" />

          {/* Gemini Model Selector */}
          <div className="pt-1 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <label className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                  <Cpu className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <span>Gemini Model</span>
                </label>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Model used for phrase translations and tutor nuance breakdowns. Default is <code className="font-mono text-indigo-600 dark:text-indigo-400 font-bold">{DEFAULT_GEMINI_MODEL}</code>.
                </p>
              </div>

              <button
                type="button"
                onClick={handleRefreshModels}
                disabled={isLoadingModels}
                className="flex items-center gap-1 text-[11px] font-bold px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition shrink-0"
                title="Refresh model list from Gemini API"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingModels ? 'animate-spin text-indigo-500' : ''}`} />
                <span>{isLoadingModels ? 'Refreshing...' : 'Refresh model list'}</span>
              </button>
            </div>

            {/* Dropdown & Custom Model Fallback */}
            <div className="space-y-2">
              <div className="relative">
                <select
                  value={isCustomModel ? '__custom__' : geminiModel}
                  onChange={(e) => handleSelectModel(e.target.value)}
                  className="w-full appearance-none px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/80 text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer font-mono"
                >
                  {availableModels.map((m) => (
                    <option key={m} value={m}>
                      {m} {m === DEFAULT_GEMINI_MODEL ? '(Default)' : ''}
                    </option>
                  ))}
                  <option value="__custom__">Custom model name...</option>
                </select>
                <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">
                  ▼
                </div>
              </div>

              {isCustomModel && (
                <div className="flex gap-2 pt-1 animate-in fade-in">
                  <input
                    type="text"
                    placeholder="Type custom model name (e.g. gemini-3.8-flash)"
                    value={customModelInput}
                    onChange={(e) => setCustomModelInput(e.target.value)}
                    className="flex-1 px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/80 text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={handleSaveCustomModel}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition shadow-xs shrink-0"
                  >
                    Apply Model
                  </button>
                </div>
              )}

              {modelsFetchError && (
                <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 font-medium">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{modelsFetchError}</span>
                </div>
              )}

              {modelSavedToast && (
                <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-semibold animate-in fade-in">
                  <CheckCircle className="w-4 h-4" />
                  <span>Model preference saved: <span className="font-mono">{geminiModel}</span></span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Display & Reader Preferences */}
        <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-6">
          <h2 className="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
            <Palette className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            Reader & Theme Preferences
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {/* Theme switcher */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block">
                Color Theme
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['dark', 'light', 'system'] as AppTheme[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={`py-2 px-3 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                      theme === t
                        ? 'border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/70 dark:text-indigo-300 dark:border-indigo-500'
                        : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    {t === 'dark' && <Moon className="w-3.5 h-3.5" />}
                    {t === 'light' && <Sun className="w-3.5 h-3.5" />}
                    {t === 'system' && <Monitor className="w-3.5 h-3.5" />}
                    <span className="capitalize">{t}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Furigana Mode */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block">
                Default Furigana Display
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['always', 'hover', 'never'] as FuriganaMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setFuriganaMode(mode)}
                    className={`py-2 px-3 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                      furiganaMode === mode
                        ? 'border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/70 dark:text-indigo-300 dark:border-indigo-500'
                        : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span className="capitalize">{mode}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Font Size */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block">
                Reader Text Size
              </label>
              <div className="grid grid-cols-4 gap-2">
                {(['sm', 'md', 'lg', 'xl'] as FontSize[]).map((sz) => (
                  <button
                    key={sz}
                    onClick={() => setFontSize(sz)}
                    className={`py-2 px-2 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1 transition ${
                      fontSize === sz
                        ? 'border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/70 dark:text-indigo-300 dark:border-indigo-500'
                        : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Type className="w-3.5 h-3.5" />
                    <span className="uppercase">{sz}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Color coding toggle */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 block">
                Vocabulary Status Highlighting
              </label>
              <button
                onClick={() => setColorCodingEnabled(!colorCodingEnabled)}
                className={`w-full py-2 px-3 rounded-xl border text-xs font-semibold flex items-center justify-between transition ${
                  colorCodingEnabled
                    ? 'border-emerald-500 bg-emerald-50/70 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : 'border-slate-200 dark:border-slate-800 text-slate-500'
                }`}
              >
                <span>{colorCodingEnabled ? 'Enabled (Known / Learning colors)' : 'Disabled (Plain text)'}</span>
                <span className="font-bold">{colorCodingEnabled ? 'ON' : 'OFF'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Local-First JSON Backup & Restore */}
        <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="space-y-1">
            <h2 className="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
              <FileJson className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
              Full JSON Backup & Restore
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xl leading-relaxed">
              LinguaForge operates 100% locally on your machine. You own your data.
              Export complete snapshots of your library, word statuses, flashcards, and history at any time.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            <button
              onClick={downloadBackupFile}
              className="flex items-center justify-center gap-2 py-3 px-4 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-md shadow-indigo-600/20 transition active:scale-95"
            >
              <Download className="w-4 h-4" />
              Download JSON Backup File
            </button>

            <label className="flex items-center justify-center gap-2 py-3 px-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800/80 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 font-bold text-xs cursor-pointer transition">
              <Upload className="w-4 h-4 text-indigo-500" />
              {isRestoring ? 'Restoring...' : 'Restore from JSON Backup'}
              <input
                type="file"
                accept=".json"
                onChange={handleRestoreFile}
                disabled={isRestoring}
                className="hidden"
              />
            </label>
          </div>

          {restoreMessage && (
            <div
              className={`p-3 rounded-xl text-xs font-semibold flex items-center gap-2 ${
                restoreMessage.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                  : 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
              }`}
            >
              {restoreMessage.type === 'success' ? (
                <CheckCircle className="w-4 h-4 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0" />
              )}
              <span>{restoreMessage.text}</span>
            </div>
          )}
        </div>

        {/* Analytics Event Log Inspector */}
        <div className="p-6 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <h2 className="font-bold text-base text-slate-900 dark:text-white flex items-center gap-2">
                <Activity className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                Local Analytics Event Log
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Tracking user interactions locally for learning analytics ({eventLogs.length} events stored)
              </p>
            </div>

            <button
              onClick={() => setShowEventInspector(!showEventInspector)}
              className="text-xs font-semibold px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
            >
              {showEventInspector ? 'Hide Events' : 'View Events'}
            </button>
          </div>

          {showEventInspector && (
            <div className="space-y-3 pt-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-slate-400">Recent 50 Events</span>
                <button
                  onClick={async () => {
                    await clearEventLogs();
                    setEventLogs([]);
                  }}
                  className="text-rose-600 hover:underline"
                >
                  Clear Event Log
                </button>
              </div>

              <div className="max-h-56 overflow-y-auto space-y-1.5 font-mono text-[11px] bg-slate-50 dark:bg-slate-950 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                {eventLogs.length === 0 ? (
                  <div className="text-slate-400 text-center py-4">No events logged yet.</div>
                ) : (
                  eventLogs.map((e, idx) => (
                    <div key={idx} className="flex items-center justify-between py-1 border-b border-slate-200/50 dark:border-slate-800/50">
                      <span className="text-indigo-600 dark:text-indigo-400 font-bold">{e.type}</span>
                      <span className="text-slate-400">{new Date(e.timestamp).toLocaleTimeString()}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Danger Zone */}
        <div className="p-6 rounded-3xl bg-rose-50/50 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-900/40 space-y-3">
          <h2 className="font-bold text-sm text-rose-800 dark:text-rose-300 flex items-center gap-2">
            <Trash2 className="w-4 h-4" />
            Reset Local Application Data
          </h2>
          <p className="text-xs text-rose-700/80 dark:text-rose-400">
            Permanently purges all IndexedDB data in your browser.
          </p>
          <button
            onClick={handleClearAllData}
            className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl transition shadow-sm"
          >
            Clear All IndexedDB Tables
          </button>
        </div>
      </main>
    </div>
  );
};
