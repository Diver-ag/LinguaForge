import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { db, type CardItem, type CardType } from '../../db/db';
import {
  getDecksWithCounts,
  createDeck,
  renameDeck,
  deleteDeck,
  updateCard,
  deleteCards,
  bulkMoveCards,
  bulkTagCards,
  createClozeCardsFromCards,
  createListeningCardsFromCards,
  getDefaultDeckId,
  type DeckWithCount,
} from '../../db/cards';
import { useAppStore } from '../../store/useAppStore';
import { getLanguagePack } from '../../packs/registry';
import { getEffectiveClozeData } from '../../core/cloze';
import { isSpeechSynthesisSupported, speakWithReliability } from '../../core/speech';
import { getStudySettings } from '../../core/studySettings';
import { FuriganaText } from '../../ui/FuriganaText';
import { ClozeSentenceView } from '../review/HighlightedSentence';
import { CardEditModal } from './CardEditModal';
import {
  Layers,
  Search,
  Plus,
  Pencil,
  Trash2,
  FolderOpen,
  PauseCircle,
  PlayCircle,
  Volume2,
  CheckSquare,
  Square,
  X,
  ArrowUpDown,
  AlertCircle,
  Loader2,
  BookOpen,
  Download,
  Upload,
  Scissors,
  Headphones,
} from 'lucide-react';

const CARD_TYPE_LABELS: Record<CardType, string> = {
  word_to_meaning: 'Word → Meaning',
  meaning_to_word: 'Meaning → Word',
  reading: 'Reading',
  cloze: 'Cloze',
  listening: 'Listening',
};

const LEVEL_SORT_ORDER: Record<string, number> = {
  N5: 1,
  N4: 2,
  N3: 3,
  N2: 4,
  N1: 5,
  A1: 1,
  A2: 2,
  B1: 3,
  B2: 4,
  C1: 5,
  C2: 6,
};

function getLevelRank(level?: string): number {
  if (!level) return 999;
  const upper = level.trim().toUpperCase();
  return LEVEL_SORT_ORDER[upper] ?? 998;
}

export const CardsView: React.FC = () => {
  const navigate = useNavigate();
  const { activeLanguageId, furiganaMode } = useAppStore();
  const pack = getLanguagePack(activeLanguageId);

  const [cards, setCards] = useState<CardItem[]>([]);
  const [decks, setDecks] = useState<DeckWithCount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search, Filters, Sort
  const [searchQuery, setSearchQuery] = useState('');
  const [deckFilter, setDeckFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | CardType>('all');
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [suspendedFilter, setSuspendedFilter] = useState<'all' | 'active' | 'suspended'>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'alphabetical' | 'level'>('newest');

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTargetDeckId, setBulkTargetDeckId] = useState<string>('');
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [isBulkBusy, setIsBulkBusy] = useState(false);

  // Deck Modals
  const [showCreateDeckModal, setShowCreateDeckModal] = useState(false);
  const [newDeckName, setNewDeckName] = useState('');
  const [newDeckDesc, setNewDeckDesc] = useState('');
  const [deckModalError, setDeckModalError] = useState<string | null>(null);

  const [renamingDeck, setRenamingDeck] = useState<DeckWithCount | null>(null);
  const [renameDeckName, setRenameDeckName] = useState('');
  const [renameDeckDesc, setRenameDeckDesc] = useState('');

  const [deletingDeck, setDeletingDeck] = useState<DeckWithCount | null>(null);
  const [deleteDeckAction, setDeleteDeckAction] = useState<'move' | 'delete'>('move');
  const [deleteDeckTargetId, setDeleteDeckTargetId] = useState<string>('');

  // Card Edit / Create Modal
  const [editingCard, setEditingCard] = useState<CardItem | null>(null);
  const [isCreatingCloze, setIsCreatingCloze] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [confirmDeleteSingleId, setConfirmDeleteSingleId] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [deckList, cardList] = await Promise.all([
        getDecksWithCounts(activeLanguageId),
        db.cards.where('languageId').equals(activeLanguageId).toArray(),
      ]);
      setDecks(deckList);
      setCards(cardList);

      const fallbackDeckId = deckList[0]?.id || getDefaultDeckId(activeLanguageId);
      setBulkTargetDeckId((prev) =>
        deckList.some((d) => d.id === prev) ? prev : fallbackDeckId
      );
      setSelectedIds((prev) => {
        const valid = new Set(cardList.map((c) => c.id));
        const next = new Set<string>();
        for (const id of prev) {
          if (valid.has(id)) next.add(id);
        }
        return next;
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to load flashcards and decks.');
    } finally {
      setIsLoading(false);
    }
  }, [activeLanguageId]);

  useEffect(() => {
    setDeckFilter('all');
    setTagFilter('all');
    setSourceFilter('all');
    setLevelFilter('all');
    setSelectedIds(new Set());
    loadData();
  }, [activeLanguageId, loadData]);

  const deckNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of decks) map.set(d.id, d.name);
    return map;
  }, [decks]);

  const availableLevels = useMemo(() => {
    const set = new Set<string>();
    for (const c of cards) {
      if (c.level && c.level.trim()) set.add(c.level.trim());
    }
    return Array.from(set).sort((a, b) => getLevelRank(a) - getLevelRank(b) || a.localeCompare(b));
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
      if (c.sourceDocTitle && c.sourceDocTitle.trim()) set.add(c.sourceDocTitle.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [cards]);

  const filteredCards = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = cards.filter((c) => {
      if (deckFilter !== 'all' && c.deckId !== deckFilter) return false;
      if (typeFilter !== 'all' && c.cardType !== typeFilter) return false;
      if (levelFilter === 'none' && c.level && c.level.trim() !== '') return false;
      if (
        levelFilter !== 'all' &&
        levelFilter !== 'none' &&
        (c.level || '').trim().toUpperCase() !== levelFilter.toUpperCase()
      ) {
        return false;
      }
      if (tagFilter !== 'all' && !(c.tags || []).includes(tagFilter)) return false;
      if (sourceFilter !== 'all' && (c.sourceDocTitle || '').trim() !== sourceFilter) return false;
      if (suspendedFilter === 'active' && c.suspended) return false;
      if (suspendedFilter === 'suspended' && !c.suspended) return false;

      if (q) {
        const hay = [
          c.word,
          c.lemma,
          c.reading,
          c.meaning,
          c.sentence || '',
          c.notes || '',
          c.sourceDocTitle || '',
          ...(c.tags || []),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list.sort((a, b) => {
      if (sortBy === 'alphabetical') {
        const aKey = (a.lemma || a.word).toLowerCase();
        const bKey = (b.lemma || b.word).toLowerCase();
        return aKey.localeCompare(bKey);
      }
      if (sortBy === 'level') {
        const diff = getLevelRank(a.level) - getLevelRank(b.level);
        if (diff !== 0) return diff;
        return b.createdAt - a.createdAt;
      }
      return b.createdAt - a.createdAt;
    });

    return list;
  }, [
    cards,
    searchQuery,
    deckFilter,
    typeFilter,
    levelFilter,
    tagFilter,
    sourceFilter,
    suspendedFilter,
    sortBy,
  ]);

  const hasActiveFilters =
    searchQuery.trim() !== '' ||
    deckFilter !== 'all' ||
    typeFilter !== 'all' ||
    levelFilter !== 'all' ||
    tagFilter !== 'all' ||
    sourceFilter !== 'all' ||
    suspendedFilter !== 'all';

  const resetFilters = () => {
    setSearchQuery('');
    setDeckFilter('all');
    setTypeFilter('all');
    setLevelFilter('all');
    setTagFilter('all');
    setSourceFilter('all');
    setSuspendedFilter('all');
  };

  const suspendedTotalCount = useMemo(
    () => cards.filter((c) => c.suspended).length,
    [cards]
  );

  const ttsSupported = isSpeechSynthesisSupported();

  const handleSpeak = async (text: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!text) return;
    if (!ttsSupported) {
      setBulkNotice('Text-to-speech is not supported in this browser.');
      return;
    }
    const settings = await getStudySettings();
    const ttsCode = pack.ttsCode || 'ja-JP';
    const preferredVoiceId =
      settings.speechVoiceByLang[pack.id] || settings.speechVoiceByLang[ttsCode];
    speakWithReliability({
      text,
      ttsCode,
      preferredVoiceId,
      rate: settings.speechRate,
      onError: (msg) => setBulkNotice(msg),
    });
  };

  // Deck handlers
  const handleCreateDeck = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeckModalError(null);
    try {
      const created = await createDeck({
        languageId: activeLanguageId,
        name: newDeckName,
        description: newDeckDesc,
      });
      setNewDeckName('');
      setNewDeckDesc('');
      setShowCreateDeckModal(false);
      await loadData();
      setDeckFilter(created.id);
    } catch (err: any) {
      setDeckModalError(err?.message || 'Could not create deck.');
    }
  };

  const handleRenameDeck = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingDeck) return;
    setDeckModalError(null);
    try {
      await renameDeck(renamingDeck.id, renameDeckName, renameDeckDesc);
      setRenamingDeck(null);
      await loadData();
    } catch (err: any) {
      setDeckModalError(err?.message || 'Could not rename deck.');
    }
  };

  const openDeleteDeckModal = (deck: DeckWithCount) => {
    const otherDecks = decks.filter((d) => d.id !== deck.id);
    setDeleteDeckAction(otherDecks.length > 0 ? 'move' : 'delete');
    setDeleteDeckTargetId(otherDecks[0]?.id || '');
    setDeckModalError(null);
    setDeletingDeck(deck);
  };

  const handleConfirmDeleteDeck = async () => {
    if (!deletingDeck) return;
    setDeckModalError(null);
    try {
      await deleteDeck(
        deletingDeck.id,
        deleteDeckAction === 'move' && deleteDeckTargetId
          ? { mode: 'move', targetDeckId: deleteDeckTargetId }
          : { mode: 'delete' }
      );
      if (deckFilter === deletingDeck.id) {
        setDeckFilter('all');
      }
      setDeletingDeck(null);
      await loadData();
    } catch (err: any) {
      setDeckModalError(err?.message || 'Could not delete deck.');
    }
  };

  // Card edit handlers
  const openEditCard = (card: CardItem) => {
    setEditingCard(card);
    setConfirmDeleteSingleId(null);
  };

  const handleToggleSuspend = async (card: CardItem, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await updateCard(card.id, { suspended: !card.suspended });
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to update card.');
    }
  };

  const handleDeleteSingleCard = async (id: string) => {
    try {
      await deleteCards([id]);
      setConfirmDeleteSingleId(null);
      if (editingCard?.id === id) {
        setEditingCard(null);
      }
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete card.');
    }
  };

  // Bulk select handlers
  const allFilteredSelected =
    filteredCards.length > 0 && filteredCards.every((c) => selectedIds.has(c.id));

  const toggleSelectAllFiltered = () => {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredCards.map((c) => c.id)));
    }
  };

  const toggleCardSelection = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkMove = async () => {
    if (selectedIds.size === 0 || !bulkTargetDeckId || isBulkBusy) return;
    setIsBulkBusy(true);
    try {
      await bulkMoveCards(Array.from(selectedIds), bulkTargetDeckId);
      setSelectedIds(new Set());
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to move selected cards.');
    } finally {
      setIsBulkBusy(false);
    }
  };

  const handleBulkTag = async (action: 'add' | 'remove') => {
    if (selectedIds.size === 0 || !bulkTagInput.trim() || isBulkBusy) return;
    setIsBulkBusy(true);
    try {
      await bulkTagCards(Array.from(selectedIds), action, bulkTagInput);
      setBulkTagInput('');
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to update tags on selected cards.');
    } finally {
      setIsBulkBusy(false);
    }
  };

  const handleConfirmBulkDelete = async () => {
    if (selectedIds.size === 0 || isBulkBusy) return;
    setIsBulkBusy(true);
    try {
      await deleteCards(Array.from(selectedIds));
      setSelectedIds(new Set());
      setConfirmBulkDelete(false);
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete selected cards.');
    } finally {
      setIsBulkBusy(false);
    }
  };

  const handleBulkCreateCloze = async () => {
    if (selectedIds.size === 0 || isBulkBusy) return;
    setIsBulkBusy(true);
    setBulkNotice(null);
    setError(null);
    try {
      const result = await createClozeCardsFromCards(
        Array.from(selectedIds),
        async (sentence, langId) => {
          const langPack = getLanguagePack(langId);
          const toks = await langPack.tokenize(sentence);
          return toks.map((t) => ({
            surface: t.surface,
            lemma: t.baseForm || t.surface,
            reading: t.reading,
            startIndex: t.startIndex,
            endIndex: t.endIndex,
          }));
        }
      );

      const parts: string[] = [];
      parts.push(
        `Created ${result.created.length} cloze ${result.created.length === 1 ? 'card' : 'cards'}`
      );
      if (result.skippedDuplicate > 0) {
        parts.push(`${result.skippedDuplicate} already existed`);
      }
      if (result.skippedNoSentence > 0) {
        parts.push(`${result.skippedNoSentence} had no sentence`);
      }
      if (result.skippedNoMatch > 0) {
        parts.push(`${result.skippedNoMatch} word not found in sentence`);
      }
      setBulkNotice(parts.join(' · '));
      setSelectedIds(new Set());
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to create cloze cards.');
    } finally {
      setIsBulkBusy(false);
    }
  };

  const handleBulkCreateListening = async () => {
    if (selectedIds.size === 0 || isBulkBusy || !ttsSupported) return;
    setIsBulkBusy(true);
    setBulkNotice(null);
    setError(null);
    try {
      const result = await createListeningCardsFromCards(Array.from(selectedIds), 'word');
      const parts: string[] = [
        `Created ${result.created.length} listening ${
          result.created.length === 1 ? 'card' : 'cards'
        }`,
      ];
      if (result.skippedDuplicate > 0) {
        parts.push(`${result.skippedDuplicate} already existed`);
      }
      setBulkNotice(parts.join(' · '));
      setSelectedIds(new Set());
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to create listening cards.');
    } finally {
      setIsBulkBusy(false);
    }
  };

  const deletingDeckOtherDecks = deletingDeck
    ? decks.filter((d) => d.id !== deletingDeck.id)
    : [];

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text)] flex flex-col pb-24 md:pb-12">
      {/* Page Header */}
      <header className="bg-[var(--surface)] border-b border-[var(--border)] px-4 sm:px-6 py-5">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-black tracking-tight flex items-center gap-2 text-[var(--text)]">
              <Layers className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
              <span>Cards</span>
            </h1>
            <p className="text-xs text-[var(--text-muted)] tabular-nums">
              {pack.flagEmoji} {pack.name} · {cards.length} total · {cards.length - suspendedTotalCount} active · {suspendedTotalCount} suspended
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Link
              to="/cards/import"
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--surface)] text-[var(--text)] text-xs font-bold transition whitespace-nowrap"
            >
              <Upload className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>Import</span>
            </Link>

            <Link
              to="/export"
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--surface)] text-[var(--text)] text-xs font-bold transition whitespace-nowrap"
            >
              <Download className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>Export</span>
            </Link>

            <button
              type="button"
              onClick={() => {
                setEditingCard(null);
                setIsCreatingCloze(true);
              }}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 min-h-[44px] rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--surface)] text-[var(--text)] text-xs font-bold transition whitespace-nowrap"
            >
              <Scissors className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>New Cloze</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setNewDeckName('');
                setNewDeckDesc('');
                setDeckModalError(null);
                setShowCreateDeckModal(true);
              }}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm transition active:scale-95 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              <span>New Deck</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl w-full mx-auto p-4 sm:p-6 space-y-6 flex-1">
        {/* Error state */}
        {error && (
          <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 flex items-center justify-between gap-3 text-xs text-rose-800 dark:text-rose-200">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={loadData}
              className="px-3 py-1.5 rounded-lg bg-rose-600 text-white font-semibold hover:bg-rose-700 transition shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* Decks Section */}
        <section aria-label="Decks" className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">
              Decks ({decks.length})
            </h2>
          </div>

          <div className="flex items-stretch gap-2.5 overflow-x-auto pb-1">
            {/* All Decks selector */}
            <button
              type="button"
              onClick={() => setDeckFilter('all')}
              className={`min-h-[44px] px-4 py-2.5 rounded-2xl border text-left transition shrink-0 flex flex-col justify-center ${
                deckFilter === 'all'
                  ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:border-indigo-400/50'
              }`}
            >
              <span className="text-xs font-bold whitespace-nowrap">All Decks</span>
              <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
                {cards.length} {cards.length === 1 ? 'card' : 'cards'}
              </span>
            </button>

            {decks.map((deck) => {
              const isSelected = deckFilter === deck.id;
              return (
                <div
                  key={deck.id}
                  className={`rounded-2xl border transition shrink-0 flex items-center gap-2 pl-3.5 pr-2 py-2 ${
                    isSelected
                      ? 'border-indigo-600 bg-[var(--accent-subtle)]'
                      : 'border-[var(--border)] bg-[var(--surface)] hover:border-indigo-400/50'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setDeckFilter(deck.id)}
                    className="text-left min-w-[90px] max-w-[190px]"
                  >
                    <div
                      className={`text-xs font-bold truncate ${
                        isSelected ? 'text-[var(--accent-text)]' : 'text-[var(--text)]'
                      }`}
                      title={deck.name}
                    >
                      {deck.name}
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
                      {deck.cardCount} {deck.cardCount === 1 ? 'card' : 'cards'}
                    </div>
                  </button>

                  <div className="flex items-center">
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingDeck(deck);
                        setRenameDeckName(deck.name);
                        setRenameDeckDesc(deck.description || '');
                        setDeckModalError(null);
                      }}
                      className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-muted)] transition"
                      aria-label={`Rename ${deck.name}`}
                      title="Rename deck"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    {decks.length > 1 && (
                      <button
                        type="button"
                        onClick={() => openDeleteDeckModal(deck)}
                        className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition"
                        aria-label={`Delete ${deck.name}`}
                        title="Delete deck"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Search, Filters & Sort Controls */}
        <section className="p-4 rounded-2xl bg-[var(--surface)] border border-[var(--border)] space-y-3">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-[var(--text-muted)] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search words, lemmas, readings, meanings, sentences, tags, notes..."
                className="w-full min-h-[44px] pl-10 pr-9 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-xs sm:text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text)]"
                  aria-label="Clear search"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <ArrowUpDown className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'newest' | 'alphabetical' | 'level')}
                aria-label="Sort cards"
                className="min-h-[44px] px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-xs font-semibold text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="newest">Sort: Newest</option>
                <option value="alphabetical">Sort: Alphabetical</option>
                <option value="level">Sort: Level</option>
              </select>
            </div>
          </div>

          {/* Filter Dropdowns */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
            <select
              value={deckFilter}
              onChange={(e) => setDeckFilter(e.target.value)}
              aria-label="Filter by deck"
              className="min-h-[40px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] text-xs font-medium"
            >
              <option value="all">Deck: All</option>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  Deck: {d.name} ({d.cardCount})
                </option>
              ))}
            </select>

            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as 'all' | CardType)}
              aria-label="Filter by card type"
              className="min-h-[40px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] text-xs font-medium"
            >
              <option value="all">Type: All</option>
              <option value="word_to_meaning">Word → Meaning</option>
              <option value="meaning_to_word">Meaning → Word</option>
              <option value="reading">Reading</option>
              <option value="cloze">Cloze</option>
              <option value="listening">Listening</option>
            </select>

            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              aria-label="Filter by level"
              className="min-h-[40px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] text-xs font-medium"
            >
              <option value="all">Level: All</option>
              {availableLevels.map((lvl) => (
                <option key={lvl} value={lvl}>
                  Level: {lvl}
                </option>
              ))}
              <option value="none">No level</option>
            </select>

            <select
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              aria-label="Filter by tag"
              className="min-h-[40px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] text-xs font-medium"
            >
              <option value="all">Tag: All</option>
              {availableTags.map((t) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </select>

            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              aria-label="Filter by source text"
              className="min-h-[40px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] text-xs font-medium truncate"
            >
              <option value="all">Source: All</option>
              {availableSources.map((src) => (
                <option key={src} value={src}>
                  {src}
                </option>
              ))}
            </select>

            <select
              value={suspendedFilter}
              onChange={(e) => setSuspendedFilter(e.target.value as 'all' | 'active' | 'suspended')}
              aria-label="Filter by suspended status"
              className="min-h-[40px] px-2.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] text-xs font-medium"
            >
              <option value="all">Status: All</option>
              <option value="active">Active only</option>
              <option value="suspended">Suspended only</option>
            </select>
          </div>

          {/* Count & Bulk Toggle Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-[var(--border)] text-xs">
            <div className="flex items-center gap-3">
              {filteredCards.length > 0 && (
                <button
                  type="button"
                  onClick={toggleSelectAllFiltered}
                  className="inline-flex items-center gap-1.5 font-semibold text-[var(--text-secondary)] hover:text-[var(--text)] py-1"
                >
                  {allFilteredSelected ? (
                    <CheckSquare className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  ) : (
                    <Square className="w-4 h-4" />
                  )}
                  <span>{allFilteredSelected ? 'Deselect all' : 'Select all'}</span>
                </button>
              )}
              <span className="text-[var(--text-muted)] tabular-nums">
                Showing {filteredCards.length} of {cards.length} {cards.length === 1 ? 'card' : 'cards'}
              </span>
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="text-xs font-semibold text-[var(--accent-text)] hover:underline"
              >
                Reset filters
              </button>
            )}
          </div>
        </section>

        {/* Bulk Action Bar */}
        {selectedIds.size > 0 && (
          <section className="p-3.5 rounded-2xl bg-[var(--accent-subtle)] border border-indigo-500/40 flex flex-col lg:flex-row lg:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 font-bold text-[var(--accent-text)] tabular-nums">
              <span>{selectedIds.size} selected</span>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="text-[11px] font-semibold underline ml-1"
              >
                Clear
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Bulk Move */}
              <div className="flex items-center gap-1.5">
                <select
                  value={bulkTargetDeckId}
                  onChange={(e) => setBulkTargetDeckId(e.target.value)}
                  aria-label="Destination deck for move"
                  className="min-h-[38px] px-2.5 py-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] text-xs font-medium"
                >
                  {decks.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={isBulkBusy}
                  onClick={handleBulkMove}
                  className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface-muted)] font-semibold text-[var(--text)] transition"
                >
                  Move
                </button>
              </div>

              {/* Bulk Tag */}
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={bulkTagInput}
                  onChange={(e) => setBulkTagInput(e.target.value)}
                  placeholder="tag1, tag2"
                  className="min-h-[38px] w-28 sm:w-36 px-2.5 py-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] text-xs"
                />
                <button
                  type="button"
                  disabled={isBulkBusy || !bulkTagInput.trim()}
                  onClick={() => handleBulkTag('add')}
                  className="min-h-[38px] px-2.5 py-1.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface-muted)] disabled:opacity-50 font-semibold text-[var(--text)] transition"
                >
                  + Tag
                </button>
                <button
                  type="button"
                  disabled={isBulkBusy || !bulkTagInput.trim()}
                  onClick={() => handleBulkTag('remove')}
                  className="min-h-[38px] px-2.5 py-1.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface-muted)] disabled:opacity-50 font-semibold text-[var(--text)] transition"
                >
                  − Tag
                </button>
              </div>

              {/* Bulk Create Cloze */}
              <button
                type="button"
                disabled={isBulkBusy}
                onClick={handleBulkCreateCloze}
                className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface-muted)] font-semibold text-[var(--text)] transition inline-flex items-center gap-1.5"
              >
                <Scissors className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                <span>Create cloze cards for selected</span>
              </button>

              {/* Bulk Create Listening */}
              {ttsSupported ? (
                <button
                  type="button"
                  disabled={isBulkBusy}
                  onClick={handleBulkCreateListening}
                  className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface-muted)] font-semibold text-[var(--text)] transition inline-flex items-center gap-1.5"
                >
                  <Headphones className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                  <span>Create listening cards for selected</span>
                </button>
              ) : (
                <span
                  title="Web Speech API text-to-speech is not supported in this browser"
                  className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[var(--surface)]/60 border border-[var(--border)] text-[var(--text-muted)] inline-flex items-center gap-1.5"
                >
                  <Headphones className="w-3.5 h-3.5" />
                  <span>Listening unavailable (no browser TTS)</span>
                </span>
              )}

              {/* Bulk Delete */}
              <button
                type="button"
                disabled={isBulkBusy}
                onClick={() => setConfirmBulkDelete(true)}
                className="min-h-[38px] px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold transition inline-flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete</span>
              </button>
            </div>
          </section>
        )}

        {bulkNotice && (
          <div className="p-3.5 rounded-2xl bg-[var(--surface)] border border-indigo-500/30 flex items-center justify-between gap-3 text-xs text-[var(--text)]">
            <span className="font-medium">{bulkNotice}</span>
            <button
              type="button"
              onClick={() => setBulkNotice(null)}
              className="text-[var(--text-muted)] hover:text-[var(--text)] p-1 rounded"
              aria-label="Dismiss message"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Card List / States */}
        {isLoading ? (
          <div className="py-16 flex flex-col items-center justify-center gap-3 text-xs text-[var(--text-muted)]">
            <Loader2 className="w-7 h-7 animate-spin text-indigo-600 dark:text-indigo-400" />
            <span>Loading cards...</span>
          </div>
        ) : cards.length === 0 ? (
          <div className="py-16 px-6 text-center rounded-3xl border border-dashed border-[var(--border)] bg-[var(--surface)] space-y-4">
            <BookOpen className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
            <div className="space-y-1">
              <h3 className="text-base font-bold text-[var(--text)]">No cards in {pack.name} yet</h3>
              <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto leading-relaxed">
                Open a text in the Reader, tap any word, choose a deck and card types, and press "Add to Cards".
              </p>
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => navigate('/reader')}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition"
              >
                Go to Reader
              </button>
              <button
                type="button"
                onClick={() => navigate('/library')}
                className="min-h-[44px] px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--border)] text-[var(--text)] text-xs font-semibold transition"
              >
                Browse Library
              </button>
            </div>
          </div>
        ) : filteredCards.length === 0 ? (
          <div className="py-14 px-6 text-center rounded-3xl border border-dashed border-[var(--border)] bg-[var(--surface)] space-y-3">
            <Search className="w-8 h-8 text-[var(--text-muted)] mx-auto" />
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-[var(--text)]">No matching cards</h3>
              <p className="text-xs text-[var(--text-muted)]">
                Try adjusting your search terms or clearing active filters.
              </p>
            </div>
            <button
              type="button"
              onClick={resetFilters}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition"
            >
              Reset Filters
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredCards.map((card) => {
              const isChecked = selectedIds.has(card.id);
              const deckName = deckNameMap.get(card.deckId) || 'Default';

              return (
                <div
                  key={card.id}
                  onClick={() => openEditCard(card)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openEditCard(card);
                    }
                  }}
                  className={`p-4 rounded-2xl border transition cursor-pointer flex items-start gap-3 ${
                    isChecked
                      ? 'border-indigo-500 bg-[var(--accent-subtle)]/40'
                      : card.suspended
                      ? 'border-[var(--border)] bg-[var(--surface-muted)]/60 opacity-80'
                      : 'border-[var(--border)] bg-[var(--surface)] hover:border-indigo-400/50'
                  }`}
                >
                  {/* Selection Checkbox */}
                  <button
                    type="button"
                    onClick={(e) => toggleCardSelection(card.id, e)}
                    aria-label={isChecked ? `Deselect ${card.word}` : `Select ${card.word}`}
                    className="min-h-[44px] min-w-[44px] -ml-2 -mt-1 flex items-center justify-center rounded-xl text-[var(--text-muted)] hover:text-indigo-600 shrink-0"
                  >
                    {isChecked ? (
                      <CheckSquare className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                    ) : (
                      <Square className="w-5 h-5" />
                    )}
                  </button>

                  {/* Main Card Body */}
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-baseline gap-2.5 flex-wrap">
                          <div className="text-xl sm:text-2xl font-bold text-[var(--text)]">
                            <FuriganaText
                              segments={card.furiganaSegments}
                              text={card.word}
                              reading={card.reading}
                              furiganaMode={furiganaMode}
                            />
                          </div>

                          {card.lemma && card.lemma !== card.word && (
                            <span className="text-xs text-[var(--text-muted)]">
                              ({card.lemma})
                            </span>
                          )}

                          <button
                            type="button"
                            onClick={(e) => handleSpeak(card.word, e)}
                            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-[var(--surface-muted)] transition"
                            aria-label={`Speak ${card.word}`}
                            title="Pronounce"
                          >
                            <Volume2 className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                          {card.meaning || 'No meaning added'}
                        </p>
                      </div>

                      {/* Row Actions */}
                      <div
                        className="flex items-center gap-0.5 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={(e) => handleToggleSuspend(card, e)}
                          className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-[var(--text-muted)] hover:text-amber-600 hover:bg-[var(--surface-muted)] transition"
                          title={card.suspended ? 'Unsuspend card' : 'Suspend card'}
                          aria-label={card.suspended ? 'Unsuspend card' : 'Suspend card'}
                        >
                          {card.suspended ? (
                            <PlayCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                          ) : (
                            <PauseCircle className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditCard(card)}
                          className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-[var(--text-muted)] hover:text-indigo-600 hover:bg-[var(--surface-muted)] transition"
                          title="Edit card"
                          aria-label={`Edit ${card.word}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteSingleId(card.id)}
                          className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-[var(--text-muted)] hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition"
                          title="Delete card"
                          aria-label={`Delete ${card.word}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {card.sentence && (
                      <div className="pt-1.5 border-t border-[var(--border)]/60 text-xs sm:text-sm text-[var(--text-secondary)]">
                        {card.cardType === 'cloze' && getEffectiveClozeData(card) ? (
                          (() => {
                            const cl = getEffectiveClozeData(card)!;
                            return (
                              <ClozeSentenceView
                                sentence={cl.sentence}
                                start={cl.start}
                                end={cl.end}
                                mode="back"
                                segments={card.sentenceFuriganaSegments}
                                furiganaMode={furiganaMode}
                              />
                            );
                          })()
                        ) : card.sentenceFuriganaSegments && card.sentenceFuriganaSegments.length > 0 ? (
                          <FuriganaText
                            segments={card.sentenceFuriganaSegments}
                            text={card.sentence}
                            furiganaMode={furiganaMode}
                          />
                        ) : (
                          <span>{card.sentence}</span>
                        )}
                      </div>
                    )}

                    {/* Clean unboxed metadata row */}
                    <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
                      <span>{deckName}</span>
                      <span aria-hidden="true">·</span>
                      <span>{CARD_TYPE_LABELS[card.cardType]}</span>
                      {card.cardType === 'listening' && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>
                            {card.listeningTarget === 'sentence' && card.sentence
                              ? 'Sentence audio'
                              : 'Word audio'}
                          </span>
                        </>
                      )}
                      {card.level && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-[var(--text-secondary)]">{card.level}</span>
                        </>
                      )}
                      {card.frequencyBand && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{card.frequencyBand}</span>
                        </>
                      )}
                      {card.partOfSpeech && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{card.partOfSpeech}</span>
                        </>
                      )}
                      {card.sourceDocTitle && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate max-w-[200px]" title={card.sourceDocTitle}>
                            {card.sourceDocTitle}
                          </span>
                        </>
                      )}
                      {card.tags && card.tags.length > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-[var(--accent-text)]">
                            {card.tags.map((t) => `#${t}`).join(' ')}
                          </span>
                        </>
                      )}
                      {card.suspended && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-amber-700 dark:text-amber-300">
                            Suspended
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Create Deck Modal */}
      {showCreateDeckModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <form
            onSubmit={handleCreateDeck}
            className="w-full max-w-md bg-[var(--surface)] border border-[var(--border)] rounded-3xl shadow-2xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-[var(--text)] flex items-center gap-2">
                <FolderOpen className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <span>Create Deck</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateDeckModal(false)}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {deckModalError && (
              <p className="text-xs font-semibold text-rose-600 dark:text-rose-400">{deckModalError}</p>
            )}

            <div className="space-y-3 text-xs">
              <label className="block space-y-1">
                <span className="font-semibold text-[var(--text-secondary)] block">Deck Name *</span>
                <input
                  type="text"
                  required
                  autoFocus
                  value={newDeckName}
                  onChange={(e) => setNewDeckName(e.target.value)}
                  placeholder="e.g. Core JLPT N5, Novel Reading..."
                  className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>

              <label className="block space-y-1">
                <span className="font-semibold text-[var(--text-secondary)] block">Description (optional)</span>
                <textarea
                  rows={2}
                  value={newDeckDesc}
                  onChange={(e) => setNewDeckDesc(e.target.value)}
                  placeholder="Notes about this deck..."
                  className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowCreateDeckModal(false)}
                className="min-h-[42px] px-4 py-2 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="min-h-[42px] px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm"
              >
                Create Deck
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Rename Deck Modal */}
      {renamingDeck && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <form
            onSubmit={handleRenameDeck}
            className="w-full max-w-md bg-[var(--surface)] border border-[var(--border)] rounded-3xl shadow-2xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-[var(--text)]">Rename Deck</h3>
              <button
                type="button"
                onClick={() => setRenamingDeck(null)}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {deckModalError && (
              <p className="text-xs font-semibold text-rose-600 dark:text-rose-400">{deckModalError}</p>
            )}

            <div className="space-y-3 text-xs">
              <label className="block space-y-1">
                <span className="font-semibold text-[var(--text-secondary)] block">Deck Name *</span>
                <input
                  type="text"
                  required
                  autoFocus
                  value={renameDeckName}
                  onChange={(e) => setRenameDeckName(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>

              <label className="block space-y-1">
                <span className="font-semibold text-[var(--text-secondary)] block">Description</span>
                <textarea
                  rows={2}
                  value={renameDeckDesc}
                  onChange={(e) => setRenameDeckDesc(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRenamingDeck(null)}
                className="min-h-[42px] px-4 py-2 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="min-h-[42px] px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm"
              >
                Save Name
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Deck Modal (asks what to do with its cards: move or delete) */}
      {deletingDeck && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-[var(--surface)] border border-[var(--border)] rounded-3xl shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-rose-600 dark:text-rose-400">
                Delete "{deletingDeck.name}"?
              </h3>
              <button
                type="button"
                onClick={() => setDeletingDeck(null)}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {deckModalError && (
              <p className="text-xs font-semibold text-rose-600 dark:text-rose-400">{deckModalError}</p>
            )}

            {deletingDeck.cardCount > 0 ? (
              <div className="space-y-3 text-xs">
                <p className="text-[var(--text-secondary)]">
                  This deck currently contains <strong className="tabular-nums">{deletingDeck.cardCount}</strong>{' '}
                  {deletingDeck.cardCount === 1 ? 'card' : 'cards'}. What would you like to do with them?
                </p>

                {deletingDeckOtherDecks.length > 0 && (
                  <label className="block p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/60 space-y-2 cursor-pointer">
                    <div className="flex items-center gap-2 font-semibold text-[var(--text)]">
                      <input
                        type="radio"
                        name="deckDeleteAction"
                        checked={deleteDeckAction === 'move'}
                        onChange={() => setDeleteDeckAction('move')}
                      />
                      <span>Move cards to another deck</span>
                    </div>
                    {deleteDeckAction === 'move' && (
                      <select
                        value={deleteDeckTargetId}
                        onChange={(e) => setDeleteDeckTargetId(e.target.value)}
                        className="w-full min-h-[38px] px-2.5 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                      >
                        {deletingDeckOtherDecks.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name} ({d.cardCount} cards)
                          </option>
                        ))}
                      </select>
                    )}
                  </label>
                )}

                <label className="block p-3 rounded-xl border border-rose-300/60 dark:border-rose-900/60 bg-rose-50/40 dark:bg-rose-950/20 cursor-pointer">
                  <div className="flex items-center gap-2 font-semibold text-rose-700 dark:text-rose-300">
                    <input
                      type="radio"
                      name="deckDeleteAction"
                      checked={deleteDeckAction === 'delete'}
                      onChange={() => setDeleteDeckAction('delete')}
                    />
                    <span>Delete all {deletingDeck.cardCount} cards in this deck</span>
                  </div>
                </label>
              </div>
            ) : (
              <p className="text-xs text-[var(--text-secondary)]">
                This deck is empty and will be permanently removed.
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeletingDeck(null)}
                className="min-h-[42px] px-4 py-2 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteDeck}
                className="min-h-[42px] px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-sm"
              >
                Delete Deck
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit / Create Card Modal (with per-card Review History & Cloze Blank Editor) */}
      <CardEditModal
        card={editingCard}
        isCreating={isCreatingCloze}
        defaultCardType="cloze"
        defaultDeckId={deckFilter !== 'all' ? deckFilter : undefined}
        decks={decks}
        languageId={activeLanguageId}
        onClose={() => {
          setEditingCard(null);
          setIsCreatingCloze(false);
        }}
        onSaved={async () => {
          await loadData();
        }}
        onDeleted={async () => {
          await loadData();
        }}
      />

      {/* Confirm Single Card Delete Modal */}
      {confirmDeleteSingleId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm bg-[var(--surface)] border border-[var(--border)] rounded-3xl shadow-2xl p-6 space-y-4">
            <h3 className="text-base font-bold text-[var(--text)]">Delete Card?</h3>
            <p className="text-xs text-[var(--text-secondary)]">
              This will permanently remove this card from your deck. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteSingleId(null)}
                className="min-h-[40px] px-4 py-2 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleDeleteSingleCard(confirmDeleteSingleId)}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Bulk Delete Modal */}
      {confirmBulkDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm bg-[var(--surface)] border border-[var(--border)] rounded-3xl shadow-2xl p-6 space-y-4">
            <h3 className="text-base font-bold text-[var(--text)]">
              Delete {selectedIds.size} selected {selectedIds.size === 1 ? 'card' : 'cards'}?
            </h3>
            <p className="text-xs text-[var(--text-secondary)]">
              Selected cards will be permanently deleted. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmBulkDelete(false)}
                className="min-h-[40px] px-4 py-2 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isBulkBusy}
                onClick={handleConfirmBulkDelete}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold"
              >
                Delete {selectedIds.size}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
