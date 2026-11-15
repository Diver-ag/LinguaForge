import React, { useState, useEffect } from 'react';
import { db, type LookupItem, type CardItem, type WordStatusType } from '../../db/db';
import { useAppStore } from '../../store/useAppStore';
import { getLanguagePack } from '../../packs/registry';
import { logEvent } from '../../core/eventLogger';
import { FuriganaText } from '../../ui/FuriganaText';
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
  BookmarkPlus,
} from 'lucide-react';

export const HistoryView: React.FC = () => {
  const { activeLanguageId, wordStatuses, setWordStatus } = useAppStore();
  const pack = getLanguagePack(activeLanguageId);

  const [viewMode, setViewMode] = useState<'lookups' | 'flashcards'>('lookups');
  const [lookups, setLookups] = useState<LookupItem[]>([]);
  const [flashcards, setFlashcards] = useState<CardItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'learning' | 'known' | 'new'>('all');
  const [sortBy, setSortBy] = useState<'recent' | 'count'>('recent');
  const [isLoading, setIsLoading] = useState(true);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [lookupItems, cardItems] = await Promise.all([
        db.lookups.where('languageId').equals(activeLanguageId).toArray(),
        db.cards.where('languageId').equals(activeLanguageId).toArray(),
      ]);
      setLookups(lookupItems);
      setFlashcards(cardItems);
      setIsLoading(false);
    } catch (err) {
      console.error('Failed to load history and cards:', err);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [activeLanguageId]);

  const handleDelete = async (id: number) => {
    await db.lookups.delete(id);
    await logEvent('lookup_deleted', { lookupId: id });
    await loadData();
  };

  const handleDeleteCard = async (id: string) => {
    await db.cards.delete(id);
    await logEvent('flashcard_deleted', { cardId: id });
    await loadData();
  };

  const handleClearAll = async () => {
    if (confirm('Clear all lookup history for this language?')) {
      await db.lookups.where('languageId').equals(activeLanguageId).delete();
      await logEvent('lookup_history_cleared', { languageId: activeLanguageId });
      await loadData();
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

  const filteredFlashcards = flashcards.filter((card) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      card.word.toLowerCase().includes(q) ||
      (card.reading && card.reading.toLowerCase().includes(q)) ||
      (card.meaning && card.meaning.toLowerCase().includes(q)) ||
      (card.sentence && card.sentence.toLowerCase().includes(q));

    if (!matchesSearch) return false;

    const currentStatus = wordStatuses[card.word] || 'new';
    if (statusFilter !== 'all' && currentStatus !== statusFilter) return false;

    return true;
  });

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text)] flex flex-col pb-24 md:pb-12">
      {/* Header */}
      <header className="bg-[var(--surface)] border-b border-[var(--border)] px-4 py-6">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <History className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
              <h1 className="text-2xl font-black tracking-tight">Vocabulary & Cards</h1>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Looked up words and saved flashcards with full furigana alignment
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* View Mode Toggle: Lookups vs Flashcards */}
            <div className="flex rounded-xl bg-[var(--surface-muted)] p-1 text-xs font-bold border border-[var(--border)]">
              <button
                onClick={() => setViewMode('lookups')}
                className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition ${
                  viewMode === 'lookups'
                    ? 'bg-[var(--surface)] text-[var(--accent-text)] shadow-sm'
                    : 'text-[var(--text-muted)]'
                }`}
              >
                <History className="w-3.5 h-3.5" />
                <span>Lookups ({lookups.length})</span>
              </button>
              <button
                onClick={() => setViewMode('flashcards')}
                className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition ${
                  viewMode === 'flashcards'
                    ? 'bg-[var(--surface)] text-[var(--accent-text)] shadow-sm'
                    : 'text-[var(--text-muted)]'
                }`}
              >
                <BookmarkPlus className="w-3.5 h-3.5" />
                <span>Flashcards ({flashcards.length})</span>
              </button>
            </div>

            {viewMode === 'lookups' && (
              <>
                <button
                  onClick={handleExportCSV}
                  disabled={lookups.length === 0}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-[var(--text)] text-xs font-semibold disabled:opacity-50 transition"
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
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main container */}
      <main className="max-w-5xl w-full mx-auto p-4 sm:p-6 space-y-4 flex-1">
        {/* Filters and search */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              placeholder={`Search ${viewMode === 'lookups' ? 'lookups' : 'flashcards'}...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
            />
          </div>

          <div className="flex items-center gap-2">
            {/* Status filter */}
            <div className="flex rounded-xl bg-[var(--surface-muted)] p-1 text-xs font-semibold border border-[var(--border)]">
              <button
                onClick={() => setStatusFilter('all')}
                className={`px-3 py-1 rounded-lg transition ${
                  statusFilter === 'all' ? 'bg-[var(--surface)] shadow-sm text-indigo-600 dark:text-indigo-400' : 'text-[var(--text-muted)]'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setStatusFilter('learning')}
                className={`px-3 py-1 rounded-lg transition ${
                  statusFilter === 'learning' ? 'bg-[var(--surface)] shadow-sm text-amber-600 dark:text-amber-400' : 'text-[var(--text-muted)]'
                }`}
              >
                Learning
              </button>
              <button
                onClick={() => setStatusFilter('known')}
                className={`px-3 py-1 rounded-lg transition ${
                  statusFilter === 'known' ? 'bg-[var(--surface)] shadow-sm text-emerald-600 dark:text-emerald-400' : 'text-[var(--text-muted)]'
                }`}
              >
                Known
              </button>
            </div>

            {viewMode === 'lookups' && (
              <button
                onClick={() => setSortBy(sortBy === 'recent' ? 'count' : 'recent')}
                className="p-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-xs font-semibold hover:bg-[var(--surface-muted)] transition flex items-center gap-1 text-[var(--text)]"
                title="Sort order"
              >
                <ArrowUpDown className="w-3.5 h-3.5" />
                <span className="capitalize">{sortBy}</span>
              </button>
            )}
          </div>
        </div>

        {/* Content View: Lookups or Flashcards */}
        {isLoading ? (
          <div className="py-20 text-center text-xs text-slate-400">Loading {viewMode}...</div>
        ) : viewMode === 'lookups' ? (
          filteredLookups.length === 0 ? (
            <div className="py-16 text-center space-y-3 rounded-2xl border border-dashed border-[var(--border)] p-8">
              <History className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
              <div className="space-y-1">
                <h3 className="font-bold text-sm text-[var(--text)]">No lookups recorded yet</h3>
                <p className="text-xs text-[var(--text-muted)] max-w-sm mx-auto">
                  Open any article in the Reader and tap words to inspect definitions. Every lookup is automatically saved here!
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
                    className="p-4 rounded-2xl bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--accent)]/40 transition space-y-2.5 shadow-xs"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="text-xl font-bold font-sans text-[var(--text)]">
                            <FuriganaText text={item.word} reading={item.reading} />
                          </div>

                          <button
                            onClick={() => handleSpeak(item.word)}
                            className="p-1 rounded-md text-[var(--text-muted)] hover:text-indigo-600 dark:hover:text-indigo-400 transition"
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
                            {currentStatus.toUpperCase()} (Toggle)
                          </button>
                        </div>

                        {item.meaning && (
                          <p className="text-xs text-[var(--text-secondary)]">{item.meaning}</p>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs font-mono font-bold px-2 py-1 rounded-lg bg-[var(--surface-muted)] text-[var(--text-secondary)]">
                          {item.count}×
                        </span>
                        <button
                          onClick={() => handleDelete(item.id!)}
                          className="p-1 rounded-lg text-[var(--text-muted)] hover:text-rose-600 transition"
                          title="Delete entry"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {item.surroundingSentence && (
                      <div className="p-2.5 rounded-xl bg-[var(--surface-muted)] border border-[var(--border)] text-xs">
                        <span className="text-[var(--text-muted)] font-semibold block mb-0.5">Surrounding Sentence:</span>
                        <span className="text-[var(--text-secondary)] italic">"{item.surroundingSentence}"</span>
                      </div>
                    )}

                    <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] pt-1">
                      <div className="flex items-center gap-2">
                        {item.documentTitle && (
                          <span className="flex items-center gap-1 font-medium text-[var(--text-secondary)]">
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
          )
        ) : (
          /* Flashcards View */
          filteredFlashcards.length === 0 ? (
            <div className="py-16 text-center space-y-3 rounded-2xl border border-dashed border-[var(--border)] p-8">
              <BookmarkPlus className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
              <div className="space-y-1">
                <h3 className="font-bold text-sm text-[var(--text)]">No flashcards saved yet</h3>
                <p className="text-xs text-[var(--text-muted)] max-w-sm mx-auto">
                  Click or tap any word in the Reader and select "Add to Cards" to build your custom vocabulary deck.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredFlashcards.map((card) => {
                const currentStatus: WordStatusType = wordStatuses[card.word] || 'new';

                return (
                  <div
                    key={card.id}
                    className="p-4 rounded-2xl bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--accent)]/40 transition space-y-2.5 shadow-xs"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Flashcard Word with Furigana */}
                          <div className="text-xl font-bold font-sans text-[var(--text)]">
                            <FuriganaText
                              segments={card.furiganaSegments}
                              text={card.word}
                              reading={card.reading}
                            />
                          </div>

                          <button
                            onClick={() => handleSpeak(card.word)}
                            className="p-1 rounded-md text-[var(--text-muted)] hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                            title="Listen"
                          >
                            <Volume2 className="w-3.5 h-3.5" />
                          </button>

                          {card.level && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-sky-100 text-sky-800 dark:bg-sky-950/80 dark:text-sky-300">
                              {card.level}
                            </span>
                          )}

                          {/* Status badge button */}
                          <button
                            onClick={async () => {
                              const next = currentStatus === 'known' ? 'learning' : 'known';
                              await setWordStatus(card.word, next);
                              await loadData();
                            }}
                            className={`text-xs px-2 py-0.5 rounded-full font-semibold transition ${
                              currentStatus === 'known'
                                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300'
                                : currentStatus === 'learning'
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300'
                                : 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-300'
                            }`}
                          >
                            {currentStatus.toUpperCase()} (Toggle)
                          </button>
                        </div>

                        {card.meaning && (
                          <p className="text-xs text-[var(--text-secondary)]">{card.meaning}</p>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => handleDeleteCard(card.id)}
                          className="p-1 rounded-lg text-[var(--text-muted)] hover:text-rose-600 transition"
                          title="Delete card"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {card.sentence && (
                      <div className="p-2.5 rounded-xl bg-[var(--surface-muted)] border border-[var(--border)] text-xs">
                        <span className="text-[var(--text-muted)] font-semibold block mb-0.5">Context Sentence:</span>
                        <div className="text-[var(--text-secondary)] italic">
                          {card.sentenceFuriganaSegments && card.sentenceFuriganaSegments.length > 0 ? (
                            <FuriganaText segments={card.sentenceFuriganaSegments} />
                          ) : (
                            <span>"{card.sentence}"</span>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] pt-1">
                      <div className="flex items-center gap-2">
                        {card.sourceDocTitle && (
                          <span className="flex items-center gap-1 font-medium text-[var(--text-secondary)]">
                            <BookOpen className="w-3 h-3" />
                            {card.sourceDocTitle}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        <span>{new Date(card.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
      </main>
    </div>
  );
};
