import React, { useState, useEffect } from 'react';
import { db, type LookupItem, type WordStatusType } from '../../db/db';
import { useAppStore } from '../../store/useAppStore';
import { getLanguagePack } from '../../packs/registry';
import { logEvent } from '../../core/eventLogger';
import {
  History,
  Search,
  Trash2,
  CheckCircle,
  Clock,
  BookOpen,
  Volume2,
  FileDown,
  Sparkles,
  ArrowUpDown,
  Filter,
} from 'lucide-react';

export const HistoryView: React.FC = () => {
  const { activeLanguageId, wordStatuses, setWordStatus } = useAppStore();
  const pack = getLanguagePack(activeLanguageId);

  const [lookups, setLookups] = useState<LookupItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'learning' | 'known' | 'new'>('all');
  const [sortBy, setSortBy] = useState<'recent' | 'count'>('recent');
  const [isLoading, setIsLoading] = useState(true);

  const loadLookups = async () => {
    setIsLoading(true);
    try {
      const items = await db.lookups.where('languageId').equals(activeLanguageId).toArray();
      setLookups(items);
      setIsLoading(false);
    } catch (err) {
      console.error('Failed to load lookups:', err);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadLookups();
  }, [activeLanguageId]);

  const handleDelete = async (id: number) => {
    await db.lookups.delete(id);
    await logEvent('lookup_deleted', { lookupId: id });
    await loadLookups();
  };

  const handleClearAll = async () => {
    if (confirm('Clear all lookup history for this language?')) {
      await db.lookups.where('languageId').equals(activeLanguageId).delete();
      await logEvent('lookup_history_cleared', { languageId: activeLanguageId });
      await loadLookups();
    }
  };

  const handleSpeak = (word: string) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(word);
      u.lang = pack.ttsCode || 'ja-JP';
      window.speechSynthesis.speak(u);
    }
  };

  const handleExportCSV = () => {
    if (lookups.length === 0) return;
    const headers = ['Word', 'Reading', 'Meaning', 'Lookup Count', 'Document', 'Sentence', 'Date'];
    const rows = lookups.map((l) => [
      `"${l.word.replace(/"/g, '""')}"`,
      `"${(l.reading || '').replace(/"/g, '""')}"`,
      `"${(l.meaning || '').replace(/"/g, '""')}"`,
      l.count,
      `"${(l.documentTitle || '').replace(/"/g, '""')}"`,
      `"${(l.surroundingSentence || '').replace(/"/g, '""')}"`,
      new Date(l.timestamp).toISOString(),
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `linguaforge-lookups-${activeLanguageId}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredLookups = lookups
    .filter((item) => {
      const q = searchQuery.toLowerCase();
      const matchesSearch =
        item.word.toLowerCase().includes(q) ||
        (item.reading && item.reading.toLowerCase().includes(q)) ||
        (item.meaning && item.meaning.toLowerCase().includes(q)) ||
        (item.surroundingSentence && item.surroundingSentence.toLowerCase().includes(q));

      if (!matchesSearch) return false;

      const currentStatus = wordStatuses[item.word] || 'new';
      if (statusFilter !== 'all' && currentStatus !== statusFilter) return false;

      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'count') {
        return b.count - a.count;
      }
      return b.timestamp - a.timestamp;
    });

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col pb-24 md:pb-12">
      {/* Header */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-4 py-6">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <History className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
              <h1 className="text-2xl font-black tracking-tight">Lookup History</h1>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Every word you tapped with surrounding context and lookup frequency
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleExportCSV}
              disabled={lookups.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold disabled:opacity-50 transition"
            >
              <FileDown className="w-4 h-4" />
              Export CSV
            </button>
            <button
              onClick={handleClearAll}
              disabled={lookups.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-xs font-semibold disabled:opacity-50 transition"
            >
              <Trash2 className="w-4 h-4" />
              Clear All
            </button>
          </div>
        </div>
      </header>

      {/* Main container */}
      <main className="max-w-5xl w-full mx-auto p-4 sm:p-6 space-y-4 flex-1">
        {/* Filters and search */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search words, readings, definitions, sentences..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
            />
          </div>

          <div className="flex items-center gap-2">
            {/* Status filter */}
            <div className="flex rounded-xl bg-slate-200/70 dark:bg-slate-800 p-1 text-xs font-semibold">
              <button
                onClick={() => setStatusFilter('all')}
                className={`px-3 py-1 rounded-lg transition ${
                  statusFilter === 'all' ? 'bg-white dark:bg-slate-900 shadow-sm text-indigo-600' : 'text-slate-500'
                }`}
              >
                All ({lookups.length})
              </button>
              <button
                onClick={() => setStatusFilter('learning')}
                className={`px-3 py-1 rounded-lg transition ${
                  statusFilter === 'learning' ? 'bg-white dark:bg-slate-900 shadow-sm text-amber-600' : 'text-slate-500'
                }`}
              >
                Learning
              </button>
              <button
                onClick={() => setStatusFilter('known')}
                className={`px-3 py-1 rounded-lg transition ${
                  statusFilter === 'known' ? 'bg-white dark:bg-slate-900 shadow-sm text-emerald-600' : 'text-slate-500'
                }`}
              >
                Known
              </button>
            </div>

            {/* Sort toggle */}
            <button
              onClick={() => setSortBy(sortBy === 'recent' ? 'count' : 'recent')}
              className="p-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 transition flex items-center gap-1 text-slate-700 dark:text-slate-300"
              title="Sort order"
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
              <span className="capitalize">{sortBy}</span>
            </button>
          </div>
        </div>

        {/* List of lookups */}
        {isLoading ? (
          <div className="py-20 text-center text-xs text-slate-400">Loading lookup history...</div>
        ) : filteredLookups.length === 0 ? (
          <div className="py-16 text-center space-y-3 rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 p-8">
            <History className="w-10 h-10 text-slate-400 mx-auto" />
            <div className="space-y-1">
              <h3 className="font-bold text-sm">No lookups recorded yet</h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Open any article in the Reader and click or tap words to inspect definitions. Every lookup is automatically saved here!
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredLookups.map((item) => {
              const currentStatus: WordStatusType = wordStatuses[item.word] || 'new';

              return (
                <div
                  key={item.id}
                  className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 transition space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xl font-bold font-sans text-slate-900 dark:text-white">
                          {item.word}
                        </span>

                        {item.reading && (
                          <span className="text-sm font-medium text-indigo-600 dark:text-indigo-400">
                            {item.reading}
                          </span>
                        )}

                        <button
                          onClick={() => handleSpeak(item.word)}
                          className="p-1 rounded-md text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                          title="Listen"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                        </button>

                        {/* Status badge button */}
                        <button
                          onClick={async () => {
                            const next = currentStatus === 'known' ? 'learning' : 'known';
                            await setWordStatus(item.word, next);
                          }}
                          className={`text-xs px-2 py-0.5 rounded-full font-semibold transition ${
                            currentStatus === 'known'
                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300'
                              : currentStatus === 'learning'
                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300'
                              : 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-300'
                          }`}
                        >
                          {currentStatus.toUpperCase()} (Click to toggle)
                        </button>
                      </div>

                      {item.meaning && (
                        <p className="text-xs text-slate-700 dark:text-slate-300">{item.meaning}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs font-mono font-bold px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                        {item.count}×
                      </span>
                      <button
                        onClick={() => handleDelete(item.id!)}
                        className="p-1 rounded-lg text-slate-400 hover:text-rose-600 transition"
                        title="Delete entry"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {item.surroundingSentence && (
                    <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800/80 text-xs">
                      <span className="text-slate-400 font-semibold block mb-0.5">Surrounding Sentence:</span>
                      <span className="text-slate-700 dark:text-slate-300 italic">"{item.surroundingSentence}"</span>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
                    <div className="flex items-center gap-2">
                      {item.documentTitle && (
                        <span className="flex items-center gap-1 font-medium text-slate-500 dark:text-slate-400">
                          <BookOpen className="w-3 h-3" />
                          {item.documentTitle}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <span>{new Date(item.timestamp).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};
