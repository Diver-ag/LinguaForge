import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, type CardItem, type DeckItem } from '../../db/db';
import { useAppStore } from '../../store/useAppStore';
import { getLanguagePack } from '../../packs/registry';
import {
  getStudySettings,
  DEFAULT_STUDY_SETTINGS,
  type StudySettings,
} from '../../core/studySettings';
import {
  answerCard,
  buildCustomStudyQueue,
  buildDeckStudyQueue,
  buryCard,
  formatRelativeDueTime,
  getDeckQueueSummaries,
  previewCardRatings,
  Rating,
  State,
  suspendCard,
  unburyAllCards,
  undoReview,
  type CustomStudyMode,
  type DeckQueueSummary,
  type Grade,
  type RatingPreviewOption,
} from '../../core/fsrsScheduler';
import { FuriganaText } from '../../ui/FuriganaText';
import { HighlightedSentence, ClozeSentenceView } from './HighlightedSentence';
import { formatClozeHint, getEffectiveClozeData } from '../../core/cloze';
import {
  isSpeechSynthesisSupported,
  speakWithReliability,
  stopActiveSpeech,
} from '../../core/speech';
import { CardEditModal } from '../cards/CardEditModal';
import { getTodayReviewCount } from '../../core/statsEngine';
import { DailyGoalRing } from '../../components/DailyGoalRing';
import {
  GraduationCap,
  Play,
  RotateCcw,
  PauseCircle,
  EyeOff,
  Pencil,
  Volume2,
  SlidersHorizontal,
  CheckCircle2,
  Clock,
  AlertCircle,
  Loader2,
  Layers,
  X,
  AlertTriangle,
  ArrowLeft,
  Headphones,
  Gauge,
} from 'lucide-react';

interface SessionStats {
  startedAt: number;
  totalAnswers: number;
  totalElapsedMs: number;
  uniqueCardIds: string[];
  ratingCounts: {
    [Rating.Again]: number;
    [Rating.Hard]: number;
    [Rating.Good]: number;
    [Rating.Easy]: number;
  };
}

interface UndoEntry {
  previousSnapshot: CardItem;
  reviewLogId: string;
  previousQueue: CardItem[];
  previousStats: SessionStats;
}

interface ActiveSession {
  title: string;
  deckId?: string;
  isCustomStudy: boolean;
  queue: CardItem[];
  initialCount: number;
  stats: SessionStats;
}

function createEmptyStats(): SessionStats {
  return {
    startedAt: Date.now(),
    totalAnswers: 0,
    totalElapsedMs: 0,
    uniqueCardIds: [],
    ratingCounts: {
      [Rating.Again]: 0,
      [Rating.Hard]: 0,
      [Rating.Good]: 0,
      [Rating.Easy]: 0,
    },
  };
}

function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

export const ReviewView: React.FC = () => {
  const navigate = useNavigate();
  const { activeLanguageId, furiganaMode } = useAppStore();
  const pack = getLanguagePack(activeLanguageId);

  // Home state
  const [studySettings, setStudySettings] = useState<StudySettings>(DEFAULT_STUDY_SETTINGS);
  const [summaries, setSummaries] = useState<DeckQueueSummary[]>([]);
  const [allDecks, setAllDecks] = useState<DeckItem[]>([]);
  const [allCards, setAllCards] = useState<CardItem[]>([]);
  const [earliestNextDueAt, setEarliestNextDueAt] = useState<number | null>(null);
  const [totalBuriedCount, setTotalBuriedCount] = useState(0);
  const [todayReviewCount, setTodayReviewCount] = useState(0);
  const [isLoadingHome, setIsLoadingHome] = useState(true);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  // Active review session state
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [finishedStats, setFinishedStats] = useState<{
    title: string;
    isCustomStudy: boolean;
    stats: SessionStats;
  } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [ratingPreviews, setRatingPreviews] = useState<RatingPreviewOption[]>([]);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [isGrading, setIsGrading] = useState(false);
  const [leechAlertCard, setLeechAlertCard] = useState<CardItem | null>(null);
  const [editingCard, setEditingCard] = useState<CardItem | null>(null);

  // Listening & TTS playback state
  const ttsSupported = isSpeechSynthesisSupported();
  const [isSpeakingAudio, setIsSpeakingAudio] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [slowSpeed, setSlowSpeed] = useState(false);

  // Custom Study modal state
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [customDeckId, setCustomDeckId] = useState<string>('all');
  const [customMode, setCustomMode] = useState<CustomStudyMode>('ahead');
  const [customAheadDays, setCustomAheadDays] = useState<number>(3);
  const [customSource, setCustomSource] = useState<string>('');
  const [customTag, setCustomTag] = useState<string>('');
  const [customLevel, setCustomLevel] = useState<string>('');
  const [customPreviewCount, setCustomPreviewCount] = useState<number>(0);

  const cardShownAtRef = useRef<number>(Date.now());

  const loadHomeData = useCallback(async () => {
    setIsLoadingHome(true);
    setHomeError(null);
    try {
      const settings = await getStudySettings();
      setStudySettings(settings);

      const [
        { summaries: sList, earliestNextDueAt: nextDue, totalBuriedCount: buried },
        cards,
        todayCount,
      ] = await Promise.all([
        getDeckQueueSummaries(activeLanguageId, settings),
        db.cards.where('languageId').equals(activeLanguageId).toArray(),
        getTodayReviewCount(activeLanguageId, settings, false),
      ]);

      setSummaries(sList);
      setAllDecks(sList.map((s) => s.deck));
      setAllCards(cards);
      setEarliestNextDueAt(nextDue);
      setTotalBuriedCount(buried);
      setTodayReviewCount(todayCount);
    } catch (err: any) {
      setHomeError(err?.message || 'Failed to load review decks.');
    } finally {
      setIsLoadingHome(false);
    }
  }, [activeLanguageId]);

  useEffect(() => {
    setSession(null);
    setFinishedStats(null);
    setRevealed(false);
    setUndoStack([]);
    setLeechAlertCard(null);
    loadHomeData();
  }, [activeLanguageId, loadHomeData]);

  // Distinct options for Custom Study
  const availableSources = useMemo(() => {
    const set = new Set<string>();
    for (const c of allCards) {
      if (!c.suspended && c.sourceDocTitle?.trim()) set.add(c.sourceDocTitle.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allCards]);

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of allCards) {
      if (!c.suspended) {
        for (const t of c.tags || []) {
          if (t.trim()) set.add(t.trim());
        }
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allCards]);

  const availableLevels = useMemo(() => {
    const set = new Set<string>();
    for (const c of allCards) {
      if (!c.suspended && c.level?.trim()) set.add(c.level.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allCards]);

  useEffect(() => {
    if (!customSource && availableSources.length > 0) setCustomSource(availableSources[0]);
  }, [availableSources, customSource]);

  useEffect(() => {
    if (!customTag && availableTags.length > 0) setCustomTag(availableTags[0]);
  }, [availableTags, customTag]);

  useEffect(() => {
    if (!customLevel && availableLevels.length > 0) setCustomLevel(availableLevels[0]);
  }, [availableLevels, customLevel]);

  // Preview matching count for Custom Study modal
  useEffect(() => {
    if (!showCustomModal) return;
    let cancelled = false;
    buildCustomStudyQueue({
      languageId: activeLanguageId,
      deckId: customDeckId,
      mode: customMode,
      aheadDays: customAheadDays,
      sourceDocTitle: customSource,
      tag: customTag,
      level: customLevel,
    })
      .then((list) => {
        if (!cancelled) setCustomPreviewCount(list.length);
      })
      .catch(() => {
        if (!cancelled) setCustomPreviewCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [
    showCustomModal,
    activeLanguageId,
    customDeckId,
    customMode,
    customAheadDays,
    customSource,
    customTag,
    customLevel,
  ]);

  const currentCard = session && session.queue.length > 0 ? session.queue[0] : null;

  // Update rating previews & reset response timer whenever current card changes
  useEffect(() => {
    if (!currentCard) {
      setRatingPreviews([]);
      return;
    }
    cardShownAtRef.current = Date.now();
    let cancelled = false;
    previewCardRatings(currentCard, studySettings, new Date())
      .then((opts) => {
        if (!cancelled) setRatingPreviews(opts);
      })
      .catch(() => {
        if (!cancelled) setRatingPreviews([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentCard, studySettings]);

  const getListeningSpeechText = useCallback((card: CardItem): string => {
    const sentence = (card.sentence || '').trim();
    if (card.listeningTarget === 'sentence' && sentence.length > 0) {
      return sentence;
    }
    return card.word || '';
  }, []);

  const speakText = useCallback(
    (text: string, overrideRate?: number) => {
      if (!text) return;
      const ttsCode = pack.ttsCode || 'ja-JP';
      const preferredVoiceId =
        studySettings.speechVoiceByLang[pack.id] || studySettings.speechVoiceByLang[ttsCode];
      const rate =
        overrideRate !== undefined
          ? overrideRate
          : slowSpeed
          ? 0.7
          : studySettings.speechRate;
      setSpeechError(null);
      setIsSpeakingAudio(true);
      speakWithReliability({
        text,
        ttsCode,
        preferredVoiceId,
        rate,
        onStart: () => {
          setSpeechError(null);
          setIsSpeakingAudio(true);
        },
        onEnd: () => setIsSpeakingAudio(false),
        onError: (msg) => {
          setIsSpeakingAudio(false);
          setSpeechError(msg);
        },
      });
    },
    [pack.id, pack.ttsCode, studySettings.speechVoiceByLang, studySettings.speechRate, slowSpeed]
  );

  // Auto-play audio when a listening card appears (if enabled in Speech settings)
  // and always stop prior audio cleanly when advancing cards or leaving review.
  useEffect(() => {
    stopActiveSpeech();
    setIsSpeakingAudio(false);
    setSpeechError(null);

    if (!currentCard || currentCard.cardType !== 'listening' || editingCard) {
      return () => {
        stopActiveSpeech();
        setIsSpeakingAudio(false);
      };
    }

    if (studySettings.listeningAutoPlay) {
      const targetText = getListeningSpeechText(currentCard);
      const rate = slowSpeed ? 0.7 : studySettings.speechRate;
      const ttsCode = pack.ttsCode || 'ja-JP';
      const preferredVoiceId =
        studySettings.speechVoiceByLang[pack.id] || studySettings.speechVoiceByLang[ttsCode];
      setIsSpeakingAudio(true);
      speakWithReliability({
        text: targetText,
        ttsCode,
        preferredVoiceId,
        rate,
        onStart: () => {
          setSpeechError(null);
          setIsSpeakingAudio(true);
        },
        onEnd: () => setIsSpeakingAudio(false),
        onError: (msg) => {
          setIsSpeakingAudio(false);
          setSpeechError(msg);
        },
      });
    }

    return () => {
      stopActiveSpeech();
      setIsSpeakingAudio(false);
    };
    // Trigger specifically on card transition or session start (not when toggling slowSpeed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCard?.id, session?.title]);

  const startDeckStudy = async (deckId: string) => {
    setHomeError(null);
    setStatusNotice(null);
    try {
      const settings = await getStudySettings();
      setStudySettings(settings);
      const { queue, deck } = await buildDeckStudyQueue(
        deckId,
        activeLanguageId,
        settings
      );

      if (queue.length === 0) {
        setStatusNotice(`"${deck.name}" has no cards due right now.`);
        await loadHomeData();
        return;
      }

      setFinishedStats(null);
      setUndoStack([]);
      setRevealed(false);
      setLeechAlertCard(null);
      setSession({
        title: deck.name,
        deckId: deck.id,
        isCustomStudy: false,
        queue,
        initialCount: queue.length,
        stats: createEmptyStats(),
      });
    } catch (err: any) {
      setHomeError(err?.message || 'Could not start study session.');
    }
  };

  const startCustomStudy = async () => {
    setHomeError(null);
    try {
      const settings = await getStudySettings();
      setStudySettings(settings);
      const queue = await buildCustomStudyQueue({
        languageId: activeLanguageId,
        deckId: customDeckId,
        mode: customMode,
        aheadDays: customAheadDays,
        sourceDocTitle: customSource,
        tag: customTag,
        level: customLevel,
      });

      if (queue.length === 0) return;

      const labelMap: Record<CustomStudyMode, string> = {
        ahead: `Review Ahead (${customAheadDays}d)`,
        source: `Source: ${customSource}`,
        tag: `Tag: #${customTag}`,
        level: `Level: ${customLevel}`,
      };

      setShowCustomModal(false);
      setFinishedStats(null);
      setUndoStack([]);
      setRevealed(false);
      setLeechAlertCard(null);
      setSession({
        title: labelMap[customMode],
        deckId: customDeckId !== 'all' ? customDeckId : undefined,
        isCustomStudy: true,
        queue,
        initialCount: queue.length,
        stats: createEmptyStats(),
      });
    } catch (err: any) {
      setHomeError(err?.message || 'Could not start custom study.');
    }
  };

  const handleUnburyAll = async () => {
    try {
      const count = await unburyAllCards(activeLanguageId);
      setStatusNotice(
        count > 0
          ? `Unburied ${count} ${count === 1 ? 'card' : 'cards'}.`
          : 'No buried cards to unbury.'
      );
      await loadHomeData();
    } catch (err: any) {
      setHomeError(err?.message || 'Failed to unbury cards.');
    }
  };

  const finishOrAdvanceSession = useCallback(
    (nextQueue: CardItem[], activeTitle: string, isCustom: boolean, nextStats: SessionStats) => {
      if (nextQueue.length === 0) {
        setSession(null);
        setFinishedStats({
          title: activeTitle,
          isCustomStudy: isCustom,
          stats: {
            ...nextStats,
            totalElapsedMs: Date.now() - nextStats.startedAt,
          },
        });
        loadHomeData();
      } else {
        setSession((prev) =>
          prev
            ? {
                ...prev,
                queue: nextQueue,
                stats: nextStats,
              }
            : null
        );
      }
      setRevealed(false);
    },
    [loadHomeData]
  );

  const handleAnswer = useCallback(
    async (rating: Grade) => {
      if (!session || !currentCard || !revealed || isGrading) return;
      setIsGrading(true);

      try {
        const elapsedMs = Math.max(200, Date.now() - cardShownAtRef.current);
        const previousQueue = [...session.queue];
        const previousStats: SessionStats = {
          ...session.stats,
          uniqueCardIds: [...session.stats.uniqueCardIds],
          ratingCounts: { ...session.stats.ratingCounts },
        };

        const result = await answerCard({
          card: currentCard,
          rating,
          elapsedMs,
          settings: studySettings,
          now: new Date(),
          isCustomStudy: session.isCustomStudy,
        });

        const nextUnique = previousStats.uniqueCardIds.includes(currentCard.id)
          ? previousStats.uniqueCardIds
          : [...previousStats.uniqueCardIds, currentCard.id];

        const nextStats: SessionStats = {
          ...previousStats,
          totalAnswers: previousStats.totalAnswers + 1,
          totalElapsedMs: Date.now() - previousStats.startedAt,
          uniqueCardIds: nextUnique,
          ratingCounts: {
            ...previousStats.ratingCounts,
            [rating]: previousStats.ratingCounts[rating] + 1,
          },
        };

        setUndoStack((prev) => [
          ...prev,
          {
            previousSnapshot: result.previousSnapshot,
            reviewLogId: result.reviewLog.id,
            previousQueue,
            previousStats,
          },
        ]);

        const rest = session.queue.slice(1);
        let nextQueue: CardItem[];

        const stillInLearning =
          result.updatedCard.state === State.Learning ||
          result.updatedCard.state === State.Relearning;

        if (stillInLearning) {
          // Re-insert into session queue; never show twice in a row unless it is the only card left
          if (rest.length === 0) {
            nextQueue = [result.updatedCard];
          } else {
            const offset = rating === Rating.Again ? 2 : 4;
            const insertAt = Math.min(rest.length, Math.max(1, offset));
            nextQueue = [
              ...rest.slice(0, insertAt),
              result.updatedCard,
              ...rest.slice(insertAt),
            ];
          }
        } else {
          nextQueue = rest;
        }

        // Guard against immediate repeat if more than 1 card remains
        if (nextQueue.length > 1 && nextQueue[0].id === currentCard.id) {
          const swapIdx = nextQueue.findIndex((c) => c.id !== currentCard.id);
          if (swapIdx > 0) {
            const copy = [...nextQueue];
            const [picked] = copy.splice(swapIdx, 1);
            copy.unshift(picked);
            nextQueue = copy;
          }
        }

        if (result.triggeredLeech) {
          setLeechAlertCard(result.updatedCard);
        }

        finishOrAdvanceSession(
          nextQueue,
          session.title,
          session.isCustomStudy,
          nextStats
        );
      } catch (err: any) {
        setHomeError(err?.message || 'Failed to record review.');
      } finally {
        setIsGrading(false);
      }
    },
    [session, currentCard, revealed, isGrading, studySettings, finishOrAdvanceSession]
  );

  const handleUndo = useCallback(async () => {
    if (undoStack.length === 0 || isGrading) return;
    const last = undoStack[undoStack.length - 1];
    try {
      await undoReview({
        previousSnapshot: last.previousSnapshot,
        reviewLogId: last.reviewLogId,
      });
      setUndoStack((prev) => prev.slice(0, -1));
      setLeechAlertCard(null);
      setFinishedStats(null);
      setRevealed(false);
      setSession((prev) => ({
        title: prev?.title || 'Review',
        deckId: prev?.deckId,
        isCustomStudy: prev?.isCustomStudy ?? false,
        initialCount: prev?.initialCount ?? last.previousQueue.length,
        queue: last.previousQueue,
        stats: last.previousStats,
      }));
    } catch (err: any) {
      setHomeError(err?.message || 'Failed to undo last answer.');
    }
  }, [undoStack, isGrading]);

  const removeCardFromQueueAndAdvance = useCallback(
    (cardId: string) => {
      if (!session) return;
      const nextQueue = session.queue.filter((c) => c.id !== cardId);
      finishOrAdvanceSession(
        nextQueue,
        session.title,
        session.isCustomStudy,
        session.stats
      );
    },
    [session, finishOrAdvanceSession]
  );

  const handleBuryCurrent = useCallback(async () => {
    if (!session || !currentCard || isGrading) return;
    try {
      await buryCard(currentCard.id, studySettings.dayResetHour);
      setLeechAlertCard(null);
      removeCardFromQueueAndAdvance(currentCard.id);
    } catch (err: any) {
      setHomeError(err?.message || 'Failed to bury card.');
    }
  }, [session, currentCard, isGrading, studySettings.dayResetHour, removeCardFromQueueAndAdvance]);

  const handleSuspendCurrent = useCallback(async () => {
    if (!session || !currentCard || isGrading) return;
    try {
      await suspendCard(currentCard.id, true);
      setLeechAlertCard(null);
      removeCardFromQueueAndAdvance(currentCard.id);
    } catch (err: any) {
      setHomeError(err?.message || 'Failed to suspend card.');
    }
  }, [session, currentCard, isGrading, removeCardFromQueueAndAdvance]);

  const handleLeechSuspend = async () => {
    if (!leechAlertCard) return;
    try {
      await suspendCard(leechAlertCard.id, true);
      const targetId = leechAlertCard.id;
      setLeechAlertCard(null);
      removeCardFromQueueAndAdvance(targetId);
    } catch (err: any) {
      setHomeError(err?.message || 'Failed to suspend leech card.');
    }
  };

  // Keyboard shortcuts during review
  useEffect(() => {
    if (!session || !currentCard || editingCard || showCustomModal || leechAlertCard) {
      return;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        if (!revealed) setRevealed(true);
        return;
      }

      if (revealed) {
        if (e.key === '1') {
          e.preventDefault();
          handleAnswer(Rating.Again);
          return;
        }
        if (e.key === '2') {
          e.preventDefault();
          handleAnswer(Rating.Hard);
          return;
        }
        if (e.key === '3') {
          e.preventDefault();
          handleAnswer(Rating.Good);
          return;
        }
        if (e.key === '4') {
          e.preventDefault();
          handleAnswer(Rating.Easy);
          return;
        }
      }

      const lower = e.key.toLowerCase();
      if (lower === 'z' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleUndo();
      } else if (lower === 's') {
        e.preventDefault();
        handleSuspendCurrent();
      } else if (lower === 'b') {
        e.preventDefault();
        handleBuryCurrent();
      } else if (lower === 'e') {
        e.preventDefault();
        setEditingCard(currentCard);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    session,
    currentCard,
    revealed,
    editingCard,
    showCustomModal,
    leechAlertCard,
    handleAnswer,
    handleUndo,
    handleSuspendCurrent,
    handleBuryCurrent,
  ]);

  const totalDueAcrossDecks = useMemo(
    () => summaries.reduce((acc, s) => acc + s.totalDue, 0),
    [summaries]
  );

  // =========================================================================
  // RENDER: END OF SESSION SUMMARY
  // =========================================================================
  if (finishedStats) {
    const { stats, title, isCustomStudy } = finishedStats;
    const total = stats.totalAnswers;
    const again = stats.ratingCounts[Rating.Again];
    const accuracyPct = total > 0 ? Math.round(((total - again) / total) * 100) : 100;

    return (
      <div className="min-h-screen bg-[var(--background)] text-[var(--text)] pb-24 md:pb-12 px-4 py-8">
        <div className="max-w-xl mx-auto bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-6 sm:p-8 space-y-6">
          <div className="space-y-1.5 text-center">
            <CheckCircle2 className="w-11 h-11 text-emerald-600 dark:text-emerald-400 mx-auto" />
            <h1 className="text-xl font-black text-[var(--text)]">Session Complete</h1>
            <p className="text-xs text-[var(--text-muted)]">
              {title}
              {isCustomStudy ? ' · Custom study (daily limits unchanged)' : ''}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-2xl font-black tabular-nums text-[var(--text)]">
                {stats.uniqueCardIds.length}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Cards ({total} reviews)
              </div>
            </div>
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-2xl font-black tabular-nums text-emerald-600 dark:text-emerald-400">
                {accuracyPct}%
              </div>
              <div className="text-[11px] text-[var(--text-muted)] mt-0.5">Accuracy</div>
            </div>
            <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] border border-[var(--border)]">
              <div className="text-2xl font-black tabular-nums text-[var(--text)]">
                {formatDurationMs(stats.totalElapsedMs)}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] mt-0.5">Time</div>
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t border-[var(--border)]">
            <div className="text-xs font-semibold text-[var(--text-secondary)]">
              Answers by Rating
            </div>
            <div className="grid grid-cols-4 gap-2 text-center text-xs tabular-nums">
              <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20">
                <div className="font-bold text-rose-700 dark:text-rose-300">Again</div>
                <div className="text-base font-black mt-0.5">{stats.ratingCounts[Rating.Again]}</div>
              </div>
              <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <div className="font-bold text-amber-700 dark:text-amber-300">Hard</div>
                <div className="text-base font-black mt-0.5">{stats.ratingCounts[Rating.Hard]}</div>
              </div>
              <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                <div className="font-bold text-emerald-700 dark:text-emerald-300">Good</div>
                <div className="text-base font-black mt-0.5">{stats.ratingCounts[Rating.Good]}</div>
              </div>
              <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/20">
                <div className="font-bold text-sky-700 dark:text-sky-300">Easy</div>
                <div className="text-base font-black mt-0.5">{stats.ratingCounts[Rating.Easy]}</div>
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-2.5 pt-2">
            {undoStack.length > 0 && (
              <button
                type="button"
                onClick={handleUndo}
                className="min-h-[44px] px-4 py-2.5 rounded-xl border border-[var(--border)] hover:bg-[var(--surface-muted)] text-xs font-bold text-[var(--text)] inline-flex items-center justify-center gap-1.5"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Undo Last</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setFinishedStats(null);
                setUndoStack([]);
                loadHomeData();
              }}
              className="flex-1 min-h-[44px] px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition"
            >
              Back to Decks
            </button>
            <button
              type="button"
              onClick={() => {
                setFinishedStats(null);
                setShowCustomModal(true);
              }}
              className="min-h-[44px] px-4 py-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--border)] text-xs font-bold text-[var(--text)]"
            >
              Custom Study
            </button>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // RENDER: ACTIVE REVIEW SESSION
  // =========================================================================
  if (session && currentCard) {
    const remainingCount = session.queue.length;
    const completedUnique = session.stats.uniqueCardIds.filter(
      (id) => !session.queue.some((c) => c.id === id)
    ).length;
    const totalGoal = Math.max(session.initialCount, completedUnique + remainingCount);
    const progressPct =
      totalGoal > 0 ? Math.min(100, Math.round((completedUnique / totalGoal) * 100)) : 0;

    return (
      <div className="min-h-screen bg-[var(--background)] text-[var(--text)] flex flex-col pb-24 md:pb-10">
        {/* Session Header & Progress */}
        <header className="bg-[var(--surface)] border-b border-[var(--border)] px-4 py-3">
          <div className="max-w-3xl mx-auto space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setSession(null);
                  setRevealed(false);
                  setLeechAlertCard(null);
                  loadHomeData();
                }}
                className="min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] hover:bg-[var(--surface-muted)] text-xs font-semibold text-[var(--text-secondary)] inline-flex items-center gap-1.5 shrink-0"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Decks</span>
              </button>

              <div className="text-center min-w-0 px-2">
                <div className="text-xs font-bold text-[var(--text)] truncate">
                  {session.title}
                </div>
                <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
                  Reviewed {session.stats.totalAnswers} · {remainingCount} remaining
                  {session.isCustomStudy ? ' · Custom study' : ''}
                </div>
              </div>

              {/* Quick card actions */}
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={handleUndo}
                  disabled={undoStack.length === 0 || isGrading}
                  title="Undo last answer (Z)"
                  aria-label="Undo last answer"
                  className="min-h-[40px] min-w-[40px] px-2.5 rounded-xl border border-[var(--border)] hover:bg-[var(--surface-muted)] disabled:opacity-40 text-xs font-semibold text-[var(--text-secondary)] inline-flex items-center justify-center gap-1"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Undo</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditingCard(currentCard)}
                  title="Edit card (E)"
                  aria-label="Edit card"
                  className="min-h-[40px] min-w-[40px] px-2.5 rounded-xl border border-[var(--border)] hover:bg-[var(--surface-muted)] text-xs font-semibold text-[var(--text-secondary)] inline-flex items-center justify-center gap-1"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Edit</span>
                </button>
                <button
                  type="button"
                  onClick={handleBuryCurrent}
                  title="Bury until tomorrow (B)"
                  aria-label="Bury card"
                  className="min-h-[40px] min-w-[40px] px-2.5 rounded-xl border border-[var(--border)] hover:bg-[var(--surface-muted)] text-xs font-semibold text-[var(--text-secondary)] inline-flex items-center justify-center gap-1"
                >
                  <EyeOff className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Bury</span>
                </button>
                <button
                  type="button"
                  onClick={handleSuspendCurrent}
                  title="Suspend card (S)"
                  aria-label="Suspend card"
                  className="min-h-[40px] min-w-[40px] px-2.5 rounded-xl border border-[var(--border)] hover:bg-rose-500/10 hover:text-rose-600 text-xs font-semibold text-[var(--text-secondary)] inline-flex items-center justify-center gap-1"
                >
                  <PauseCircle className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Suspend</span>
                </button>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="w-full h-1.5 rounded-full bg-[var(--surface-muted)] overflow-hidden">
              <div
                className="h-full bg-indigo-600 dark:bg-indigo-500 transition-transform duration-200 origin-left"
                style={{ transform: `scaleX(${progressPct / 100})` }}
              />
            </div>
          </div>
        </header>

        {/* Main Card Stage */}
        <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-6 flex flex-col justify-between gap-5">
          {/* Leech Notice */}
          {leechAlertCard && (
            <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <div className="font-bold text-[var(--text)]">
                    Leech detected: "{leechAlertCard.word}"
                  </div>
                  <p className="text-[var(--text-secondary)]">
                    This card has lapsed {leechAlertCard.lapses ?? studySettings.leechThreshold} times and was tagged <span className="font-semibold">#leech</span>.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleLeechSuspend}
                  className="min-h-[38px] px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold"
                >
                  Suspend
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const target = leechAlertCard;
                    setLeechAlertCard(null);
                    setEditingCard(target);
                  }}
                  className="min-h-[38px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] font-semibold text-[var(--text)]"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setLeechAlertCard(null)}
                  className="min-h-[38px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] font-semibold text-[var(--text)]"
                >
                  Keep
                </button>
              </div>
            </div>
          )}

          {/* Flashcard Surface */}
          <div className="flex-1 flex flex-col justify-center">
            <div className="w-full rounded-3xl bg-[var(--surface)] border border-[var(--border)] p-6 sm:p-10 space-y-6">
              {/* Quiet 1-line unboxed card type & status metadata */}
              <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
                <span>
                  {currentCard.cardType === 'word_to_meaning'
                    ? 'Word → Meaning'
                    : currentCard.cardType === 'meaning_to_word'
                    ? 'Meaning → Word'
                    : currentCard.cardType === 'cloze'
                    ? 'Cloze'
                    : currentCard.cardType === 'listening'
                    ? 'Listening'
                    : 'Reading'}
                </span>
                <span className="tabular-nums">
                  {currentCard.state === State.New || currentCard.state === undefined
                    ? 'New card'
                    : currentCard.state === State.Review
                    ? `Review · Reps ${currentCard.reps ?? 0}`
                    : `Learning · Step ${(currentCard.learningSteps ?? 0) + 1}`}
                </span>
              </div>

              {/* FRONT FACE */}
              <div className="py-4 text-center space-y-5">
                {currentCard.cardType === 'word_to_meaning' && (
                  <>
                    <div className="text-4xl sm:text-5xl font-bold text-[var(--text)] leading-snug">
                      <FuriganaText
                        segments={currentCard.furiganaSegments}
                        text={currentCard.word}
                        reading={currentCard.reading}
                        furiganaMode={furiganaMode}
                      />
                    </div>
                    {currentCard.sentence && (
                      <div className="text-base sm:text-lg text-[var(--text-secondary)] leading-relaxed max-w-xl mx-auto">
                        <HighlightedSentence
                          sentence={currentCard.sentence}
                          segments={currentCard.sentenceFuriganaSegments}
                          targetWord={currentCard.word}
                          targetLemma={currentCard.lemma}
                          furiganaMode={furiganaMode}
                        />
                      </div>
                    )}
                  </>
                )}

                {currentCard.cardType === 'meaning_to_word' && (
                  <div className="text-2xl sm:text-3xl font-bold text-[var(--text)] leading-relaxed max-w-xl mx-auto">
                    {currentCard.meaning}
                  </div>
                )}

                {currentCard.cardType === 'reading' && (
                  <div className="text-4xl sm:text-5xl font-bold text-[var(--text)] leading-snug">
                    {currentCard.word}
                  </div>
                )}

                {currentCard.cardType === 'cloze' && (() => {
                  const cloze = getEffectiveClozeData(currentCard);
                  const hintText = formatClozeHint(currentCard, studySettings.clozeHintMode);
                  return (
                    <div className="space-y-4 max-w-xl mx-auto">
                      <div className="text-xl sm:text-2xl font-medium text-[var(--text)] leading-relaxed">
                        {cloze ? (
                          <ClozeSentenceView
                            sentence={cloze.sentence}
                            start={cloze.start}
                            end={cloze.end}
                            mode="front"
                            segments={currentCard.sentenceFuriganaSegments}
                            furiganaMode={furiganaMode}
                          />
                        ) : (
                          currentCard.sentence || currentCard.word
                        )}
                      </div>
                      {hintText && (
                        <div className="text-sm font-medium text-[var(--text-muted)]">
                          Hint: {hintText}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {currentCard.cardType === 'listening' && (() => {
                  const speechText = getListeningSpeechText(currentCard);
                  const isSentenceAudio =
                    currentCard.listeningTarget === 'sentence' &&
                    Boolean((currentCard.sentence || '').trim());
                  const activeRate = slowSpeed ? 0.7 : studySettings.speechRate;

                  return (
                    <div className="space-y-5 max-w-md mx-auto">
                      <div className="flex flex-col items-center gap-3">
                        <button
                          type="button"
                          onClick={() => speakText(speechText, activeRate)}
                          aria-label={
                            isSentenceAudio ? 'Play sentence audio' : 'Play word audio'
                          }
                          className={`w-28 h-28 rounded-full flex items-center justify-center shadow-lg transition active:scale-95 ${
                            isSpeakingAudio
                              ? 'bg-indigo-700 text-white ring-4 ring-indigo-500/35 animate-pulse'
                              : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                          }`}
                        >
                          <Volume2 className="w-12 h-12" />
                        </button>

                        <div className="space-y-0.5">
                          <div className="text-sm font-bold text-[var(--text)]">
                            {isSpeakingAudio
                              ? 'Playing audio...'
                              : 'Tap to listen'}
                          </div>
                          <div className="text-xs text-[var(--text-muted)] flex items-center justify-center gap-1.5 tabular-nums">
                            <Headphones className="w-3.5 h-3.5" />
                            <span>
                              {isSentenceAudio ? 'Sentence audio' : 'Word audio'} ·{' '}
                              {activeRate.toFixed(2).replace(/\.?0+$/, '')}x
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Replay + 0.7x Slower toggle */}
                      <div className="flex items-center justify-center gap-2.5 flex-wrap">
                        <button
                          type="button"
                          onClick={() => speakText(speechText, activeRate)}
                          className="min-h-[44px] px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--border)] text-xs font-bold text-[var(--text)] inline-flex items-center gap-1.5 transition"
                        >
                          <RotateCcw className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                          <span>Replay</span>
                        </button>

                        <button
                          type="button"
                          aria-pressed={slowSpeed}
                          onClick={() => {
                            const nextSlow = !slowSpeed;
                            setSlowSpeed(nextSlow);
                            speakText(
                              speechText,
                              nextSlow ? 0.7 : studySettings.speechRate
                            );
                          }}
                          className={`min-h-[44px] px-4 py-2 rounded-xl border text-xs font-bold inline-flex items-center gap-1.5 transition tabular-nums ${
                            slowSpeed
                              ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                              : 'border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--border)] text-[var(--text-secondary)]'
                          }`}
                        >
                          <Gauge className="w-4 h-4" />
                          <span>0.7x Slower</span>
                        </button>
                      </div>

                      {!ttsSupported && !speechError && (
                        <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 text-left">
                          Text-to-speech is not supported in this browser, so listening audio cannot play here.
                        </div>
                      )}

                      {speechError && (
                        <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 flex items-center justify-between gap-3 text-xs text-rose-800 dark:text-rose-200 text-left">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
                            <span>{speechError}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => speakText(speechText, activeRate)}
                            className="min-h-[36px] px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold shrink-0"
                          >
                            Retry
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* BACK FACE (after reveal) */}
              {revealed && (
                <div className="pt-6 border-t border-[var(--border)] space-y-5 animate-in fade-in">
                  {currentCard.cardType === 'word_to_meaning' && (
                    <div className="space-y-4 text-center">
                      {currentCard.reading && (
                        <div className="text-lg font-semibold text-indigo-600 dark:text-indigo-400">
                          {currentCard.reading}
                        </div>
                      )}
                      <div className="text-xl sm:text-2xl font-bold text-[var(--text)] leading-relaxed">
                        {currentCard.meaning}
                      </div>
                      <div className="flex items-center justify-center flex-wrap gap-2 text-xs text-[var(--text-muted)]">
                        {currentCard.partOfSpeech && <span>{currentCard.partOfSpeech}</span>}
                        {currentCard.partOfSpeech && currentCard.level && (
                          <span aria-hidden="true">·</span>
                        )}
                        {currentCard.level && (
                          <span className="font-semibold text-[var(--text-secondary)]">
                            {currentCard.level}
                          </span>
                        )}
                        {currentCard.frequencyBand && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{currentCard.frequencyBand}</span>
                          </>
                        )}
                      </div>
                      {currentCard.sentence && (
                        <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] text-sm sm:text-base text-[var(--text-secondary)] leading-relaxed max-w-xl mx-auto">
                          <HighlightedSentence
                            sentence={currentCard.sentence}
                            segments={currentCard.sentenceFuriganaSegments}
                            targetWord={currentCard.word}
                            targetLemma={currentCard.lemma}
                            furiganaMode={furiganaMode}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {currentCard.cardType === 'meaning_to_word' && (
                    <div className="space-y-4 text-center">
                      <div className="text-3xl sm:text-4xl font-bold text-[var(--text)] leading-snug">
                        <FuriganaText
                          segments={currentCard.furiganaSegments}
                          text={currentCard.word}
                          reading={currentCard.reading}
                          furiganaMode={furiganaMode}
                        />
                      </div>
                      {currentCard.reading && (
                        <div className="text-base font-semibold text-indigo-600 dark:text-indigo-400">
                          {currentCard.reading}
                        </div>
                      )}
                      {(currentCard.partOfSpeech || currentCard.level) && (
                        <div className="flex items-center justify-center gap-2 text-xs text-[var(--text-muted)]">
                          {currentCard.partOfSpeech && <span>{currentCard.partOfSpeech}</span>}
                          {currentCard.partOfSpeech && currentCard.level && (
                            <span aria-hidden="true">·</span>
                          )}
                          {currentCard.level && (
                            <span className="font-semibold text-[var(--text-secondary)]">
                              {currentCard.level}
                            </span>
                          )}
                        </div>
                      )}
                      {currentCard.sentence && (
                        <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] text-sm text-[var(--text-secondary)] leading-relaxed max-w-xl mx-auto">
                          <HighlightedSentence
                            sentence={currentCard.sentence}
                            segments={currentCard.sentenceFuriganaSegments}
                            targetWord={currentCard.word}
                            targetLemma={currentCard.lemma}
                            furiganaMode={furiganaMode}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {currentCard.cardType === 'reading' && (
                    <div className="space-y-4 text-center">
                      <div className="text-2xl sm:text-3xl font-bold text-indigo-600 dark:text-indigo-400">
                        {currentCard.reading || 'No reading saved'}
                      </div>
                      <div className="text-lg font-medium text-[var(--text)]">
                        <FuriganaText
                          segments={currentCard.furiganaSegments}
                          text={currentCard.word}
                          reading={currentCard.reading}
                          furiganaMode={furiganaMode}
                        />
                      </div>
                      {currentCard.meaning && (
                        <div className="text-base text-[var(--text-secondary)]">
                          {currentCard.meaning}
                        </div>
                      )}
                      {currentCard.sentence && (
                        <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] text-sm text-[var(--text-secondary)] leading-relaxed max-w-xl mx-auto">
                          <HighlightedSentence
                            sentence={currentCard.sentence}
                            segments={currentCard.sentenceFuriganaSegments}
                            targetWord={currentCard.word}
                            targetLemma={currentCard.lemma}
                            furiganaMode={furiganaMode}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {currentCard.cardType === 'cloze' && (() => {
                    const cloze = getEffectiveClozeData(currentCard);
                    const answerWord = cloze?.answer || currentCard.word;
                    const readingText = cloze?.reading || currentCard.reading;
                    return (
                      <div className="space-y-4 text-center">
                        {cloze && (
                          <div className="p-4 rounded-2xl bg-[var(--surface-muted)] text-base sm:text-lg text-[var(--text)] leading-relaxed max-w-xl mx-auto">
                            <ClozeSentenceView
                              sentence={cloze.sentence}
                              start={cloze.start}
                              end={cloze.end}
                              mode="back"
                              segments={currentCard.sentenceFuriganaSegments}
                              furiganaMode={furiganaMode}
                            />
                          </div>
                        )}
                        <div className="text-2xl sm:text-3xl font-bold text-[var(--text)]">
                          {answerWord}
                        </div>
                        {readingText && (
                          <div className="text-base font-semibold text-indigo-600 dark:text-indigo-400">
                            {readingText}
                          </div>
                        )}
                        {currentCard.meaning && (
                          <div className="text-lg font-medium text-[var(--text-secondary)]">
                            {currentCard.meaning}
                          </div>
                        )}
                        {(currentCard.partOfSpeech || currentCard.level) && (
                          <div className="flex items-center justify-center gap-2 text-xs text-[var(--text-muted)]">
                            {currentCard.partOfSpeech && <span>{currentCard.partOfSpeech}</span>}
                            {currentCard.partOfSpeech && currentCard.level && (
                              <span aria-hidden="true">·</span>
                            )}
                            {currentCard.level && (
                              <span className="font-semibold text-[var(--text-secondary)]">
                                {currentCard.level}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {currentCard.cardType === 'listening' && (
                    <div className="space-y-4 text-center">
                      <div className="text-3xl sm:text-4xl font-bold text-[var(--text)] leading-snug">
                        <FuriganaText
                          segments={currentCard.furiganaSegments}
                          text={currentCard.word}
                          reading={currentCard.reading}
                          furiganaMode={furiganaMode}
                        />
                      </div>
                      {currentCard.reading && (
                        <div className="text-base font-semibold text-indigo-600 dark:text-indigo-400">
                          {currentCard.reading}
                        </div>
                      )}
                      {currentCard.meaning && (
                        <div className="text-xl font-bold text-[var(--text)] leading-relaxed">
                          {currentCard.meaning}
                        </div>
                      )}
                      {(currentCard.partOfSpeech || currentCard.level || currentCard.frequencyBand) && (
                        <div className="flex items-center justify-center flex-wrap gap-2 text-xs text-[var(--text-muted)]">
                          {currentCard.partOfSpeech && <span>{currentCard.partOfSpeech}</span>}
                          {currentCard.partOfSpeech && currentCard.level && (
                            <span aria-hidden="true">·</span>
                          )}
                          {currentCard.level && (
                            <span className="font-semibold text-[var(--text-secondary)]">
                              {currentCard.level}
                            </span>
                          )}
                          {currentCard.frequencyBand && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{currentCard.frequencyBand}</span>
                            </>
                          )}
                        </div>
                      )}
                      {currentCard.sentence && (
                        <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)] text-sm sm:text-base text-[var(--text-secondary)] leading-relaxed max-w-xl mx-auto">
                          <HighlightedSentence
                            sentence={currentCard.sentence}
                            segments={currentCard.sentenceFuriganaSegments}
                            targetWord={currentCard.word}
                            targetLemma={currentCard.lemma}
                            furiganaMode={furiganaMode}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {currentCard.notes && (
                    <p className="text-xs text-[var(--text-muted)] text-center max-w-lg mx-auto">
                      Note: {currentCard.notes}
                    </p>
                  )}

                  {/* Shared Back Footer: Source Text Title + Browser TTS Button */}
                  <div className="pt-3 border-t border-[var(--border)]/70 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
                    <div className="truncate max-w-[70%]">
                      {currentCard.sourceDocTitle
                        ? `Source: ${currentCard.sourceDocTitle}`
                        : 'Source: Manual / Dictionary'}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        speakText(
                          currentCard.cardType === 'cloze'
                            ? currentCard.cloze?.sentence || currentCard.sentence || currentCard.word
                            : currentCard.cardType === 'listening'
                            ? getListeningSpeechText(currentCard)
                            : currentCard.word
                        )
                      }
                      className="min-h-[40px] px-3.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--border)] text-[var(--text)] font-semibold inline-flex items-center gap-1.5 transition"
                      aria-label={
                        currentCard.cardType === 'cloze'
                          ? 'Hear pronunciation of full sentence'
                          : currentCard.cardType === 'listening'
                          ? 'Replay listening card audio'
                          : `Hear pronunciation of ${currentCard.word}`
                      }
                    >
                      <Volume2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                      <span>
                        {currentCard.cardType === 'cloze'
                          ? 'Listen sentence'
                          : currentCard.cardType === 'listening'
                          ? 'Replay'
                          : 'Listen'}
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Bottom Thumb-Zone Answer Controls */}
          <div className="pt-1">
            {!revealed ? (
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="w-full min-h-[56px] py-3.5 px-6 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold shadow-sm transition active:scale-[0.99]"
              >
                Show answer <span className="opacity-75 font-normal ml-1.5">(Space)</span>
              </button>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {ratingPreviews.map((opt, idx) => {
                  const styleByGrade: Record<Grade, string> = {
                    [Rating.Again]:
                      'border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 text-rose-700 dark:text-rose-300',
                    [Rating.Hard]:
                      'border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-800 dark:text-amber-300',
                    [Rating.Good]:
                      'border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300',
                    [Rating.Easy]:
                      'border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-sky-700 dark:text-sky-300',
                  };

                  return (
                    <button
                      key={opt.grade}
                      type="button"
                      disabled={isGrading}
                      onClick={() => handleAnswer(opt.grade)}
                      className={`min-h-[58px] px-3 py-2.5 rounded-2xl border font-bold transition active:scale-[0.98] disabled:opacity-50 flex flex-col items-center justify-center gap-0.5 ${styleByGrade[opt.grade]}`}
                    >
                      <span className="text-sm">
                        {opt.label}{' '}
                        <span className="text-[11px] opacity-70 font-normal">({idx + 1})</span>
                      </span>
                      <span className="text-xs font-semibold tabular-nums opacity-90">
                        {opt.intervalText}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </main>

        {/* Edit Card Modal from inside Review */}
        <CardEditModal
          card={editingCard}
          decks={allDecks}
          languageId={activeLanguageId}
          onClose={() => setEditingCard(null)}
          onSaved={async (updated) => {
            if (!updated || !session) return;
            if (updated.suspended || updated.buried) {
              removeCardFromQueueAndAdvance(updated.id);
            } else {
              setSession((prev) =>
                prev
                  ? {
                      ...prev,
                      queue: prev.queue.map((c) => (c.id === updated.id ? updated : c)),
                    }
                  : null
              );
            }
          }}
          onDeleted={async (deletedId) => {
            removeCardFromQueueAndAdvance(deletedId);
          }}
        />
      </div>
    );
  }

  // =========================================================================
  // RENDER: REVIEW HOME (DECK PICKER)
  // =========================================================================
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text)] flex flex-col pb-24 md:pb-12">
      <header className="bg-[var(--surface)] border-b border-[var(--border)] px-4 sm:px-6 py-5">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-black tracking-tight flex items-center gap-2 text-[var(--text)]">
              <GraduationCap className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
              <span>Review</span>
            </h1>
            <p className="text-xs text-[var(--text-muted)] tabular-nums">
              {pack.flagEmoji} {pack.name} · Retention {Math.round(studySettings.desiredRetention * 100)}% · {totalDueAcrossDecks} due today
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {totalBuriedCount > 0 && (
              <button
                type="button"
                onClick={handleUnburyAll}
                className="min-h-[44px] px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--border)] text-xs font-bold text-[var(--text)] inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <EyeOff className="w-4 h-4" />
                <span>Unbury all ({totalBuriedCount})</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowCustomModal(true)}
              disabled={allCards.filter((c) => !c.suspended).length === 0}
              className="min-h-[44px] px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] disabled:opacity-50 text-xs font-bold text-[var(--text)] inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <SlidersHorizontal className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>Custom study</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl w-full mx-auto p-4 sm:p-6 space-y-6 flex-1">
        {homeError && (
          <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 flex items-center justify-between gap-3 text-xs text-rose-800 dark:text-rose-200">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <span>{homeError}</span>
            </div>
            <button
              type="button"
              onClick={loadHomeData}
              className="px-3 py-1.5 rounded-lg bg-rose-600 text-white font-semibold hover:bg-rose-700"
            >
              Retry
            </button>
          </div>
        )}

        {statusNotice && (
          <div className="p-3.5 rounded-2xl bg-[var(--accent-subtle)] border border-indigo-500/30 flex items-center justify-between gap-2 text-xs text-[var(--accent-text)] font-semibold">
            <span>{statusNotice}</span>
            <button
              type="button"
              onClick={() => setStatusNotice(null)}
              className="p-1 rounded hover:bg-black/5"
              aria-label="Dismiss notice"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {isLoadingHome ? (
          <div className="py-16 flex flex-col items-center justify-center gap-3 text-xs text-[var(--text-muted)]">
            <Loader2 className="w-7 h-7 animate-spin text-indigo-600 dark:text-indigo-400" />
            <span>Building review queues...</span>
          </div>
        ) : allCards.length === 0 ? (
          <div className="py-16 px-6 text-center rounded-3xl border border-dashed border-[var(--border)] bg-[var(--surface)] space-y-4">
            <Layers className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
            <div className="space-y-1">
              <h2 className="text-base font-bold text-[var(--text)]">
                No cards in {pack.name} yet
              </h2>
              <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto leading-relaxed">
                Add flashcards from any word popup in the Reader, then come back here to review them on your FSRS schedule.
              </p>
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => navigate('/reader')}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold"
              >
                Go to Reader
              </button>
              <button
                type="button"
                onClick={() => navigate('/cards')}
                className="min-h-[44px] px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] text-xs font-semibold"
              >
                Open Cards
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Friendly "All done for today" Banner when 0 cards are due */}
            {totalDueAcrossDecks === 0 && (
              <section className="p-6 rounded-3xl bg-[var(--surface)] border border-[var(--border)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-start gap-3.5">
                  <CheckCircle2 className="w-8 h-8 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <h2 className="text-base font-bold text-[var(--text)]">
                      All done for today
                    </h2>
                    <p className="text-xs text-[var(--text-secondary)] flex items-center gap-1.5 flex-wrap">
                      <Clock className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      <span>
                        {earliestNextDueAt !== null
                          ? `Next card due ${formatRelativeDueTime(earliestNextDueAt)}.`
                          : 'All active cards are paused or completed.'}
                      </span>
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCustomModal(true)}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shrink-0"
                >
                  Custom study
                </button>
              </section>
            )}

            {/* Daily Goal Progress Ring */}
            <section className="p-4 sm:p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <DailyGoalRing
                reviewed={todayReviewCount}
                goal={studySettings.dailyGoalReviews}
              />
              <button
                type="button"
                onClick={() => navigate('/stats')}
                className="min-h-[40px] px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--border)] text-xs font-bold text-[var(--text)] self-start sm:self-center shrink-0"
              >
                View Stats
              </button>
            </section>

            {/* Deck Picker */}
            <section className="space-y-3" aria-label="Study decks">
              <h2 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">
                Decks
              </h2>

              <div className="space-y-3">
                {summaries.map((s) => (
                  <div
                    key={s.deck.id}
                    className="p-4 sm:p-5 rounded-2xl bg-[var(--surface)] border border-[var(--border)] flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                  >
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-base font-bold text-[var(--text)] truncate">
                          {s.deck.name}
                        </h3>
                        {s.deck.studySettings && (
                          <span className="text-[11px] text-[var(--text-muted)]">
                            · Custom deck limits
                          </span>
                        )}
                      </div>
                      {s.deck.description && (
                        <p className="text-xs text-[var(--text-secondary)] truncate">
                          {s.deck.description}
                        </p>
                      )}
                      <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">
                        <span className="font-semibold text-sky-700 dark:text-sky-300">
                          New {s.newCount}
                        </span>
                        <span aria-hidden="true" className="text-[var(--text-muted)]">
                          ·
                        </span>
                        <span className="font-semibold text-amber-700 dark:text-amber-300">
                          Learning {s.learningCount}
                        </span>
                        <span aria-hidden="true" className="text-[var(--text-muted)]">
                          ·
                        </span>
                        <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                          Due {s.dueReviewCount}
                        </span>
                        <span aria-hidden="true" className="text-[var(--text-muted)]">
                          ·
                        </span>
                        <span className="text-[var(--text-muted)]">
                          {s.totalCards} total
                          {s.buriedCount > 0 ? ` · ${s.buriedCount} buried` : ''}
                          {s.suspendedCount > 0 ? ` · ${s.suspendedCount} suspended` : ''}
                        </span>
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
                        Today: {s.newStudiedToday}/{s.newDailyLimit} new · {s.reviewsDoneToday}/{s.reviewDailyLimit} reviews
                        {s.totalDue === 0 && s.nextDueAt !== null && (
                          <span> · Next due {formatRelativeDueTime(s.nextDueAt)}</span>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={s.totalDue === 0}
                      onClick={() => startDeckStudy(s.deck.id)}
                      className="min-h-[44px] px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-[var(--surface-muted)] disabled:text-[var(--text-muted)] text-white text-xs font-bold inline-flex items-center justify-center gap-1.5 shrink-0 transition"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>{s.totalDue > 0 ? `Study (${s.totalDue})` : 'All done'}</span>
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </main>

      {/* Custom Study Modal */}
      {showCustomModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-[var(--surface)] border border-[var(--border)] rounded-3xl shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
              <h3 className="text-base font-bold text-[var(--text)] flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <span>Custom Study</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowCustomModal(false)}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                aria-label="Close custom study"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              Study outside your normal schedule. Custom study does not alter or count toward your daily new/review limits.
            </p>

            {/* Mode selector */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              {(
                [
                  { id: 'ahead', label: 'Review ahead' },
                  { id: 'source', label: 'By source text' },
                  { id: 'tag', label: 'By tag' },
                  { id: 'level', label: 'By level' },
                ] as { id: CustomStudyMode; label: string }[]
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setCustomMode(m.id)}
                  className={`min-h-[40px] px-3 py-2 rounded-xl border font-semibold transition ${
                    customMode === m.id
                      ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                      : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-secondary)]'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {/* Deck scope */}
            <label className="block space-y-1 text-xs">
              <span className="font-semibold text-[var(--text-secondary)] block">Deck</span>
              <select
                value={customDeckId}
                onChange={(e) => setCustomDeckId(e.target.value)}
                className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
              >
                <option value="all">All decks in {pack.name}</option>
                {allDecks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>

            {/* Mode-specific input */}
            {customMode === 'ahead' && (
              <div className="space-y-2 text-xs">
                <label className="block space-y-1">
                  <span className="font-semibold text-[var(--text-secondary)] block">
                    Review cards due within next (days)
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={customAheadDays}
                    onChange={(e) =>
                      setCustomAheadDays(Math.max(1, Number(e.target.value) || 1))
                    }
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)] tabular-nums"
                  />
                </label>
                <div className="flex gap-2">
                  {[1, 3, 7, 14].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setCustomAheadDays(d)}
                      className={`px-3 py-1 rounded-lg border text-xs font-semibold tabular-nums ${
                        customAheadDays === d
                          ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                          : 'border-[var(--border)] text-[var(--text-secondary)]'
                      }`}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
              </div>
            )}

            {customMode === 'source' && (
              <label className="block space-y-1 text-xs">
                <span className="font-semibold text-[var(--text-secondary)] block">
                  Source Text
                </span>
                {availableSources.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">No source texts on cards yet.</p>
                ) : (
                  <select
                    value={customSource}
                    onChange={(e) => setCustomSource(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
                  >
                    {availableSources.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            )}

            {customMode === 'tag' && (
              <label className="block space-y-1 text-xs">
                <span className="font-semibold text-[var(--text-secondary)] block">Tag</span>
                {availableTags.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">No tags on cards yet.</p>
                ) : (
                  <select
                    value={customTag}
                    onChange={(e) => setCustomTag(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
                  >
                    {availableTags.map((t) => (
                      <option key={t} value={t}>
                        #{t}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            )}

            {customMode === 'level' && (
              <label className="block space-y-1 text-xs">
                <span className="font-semibold text-[var(--text-secondary)] block">Level</span>
                {availableLevels.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">No levels on cards yet.</p>
                ) : (
                  <select
                    value={customLevel}
                    onChange={(e) => setCustomLevel(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
                  >
                    {availableLevels.map((lvl) => (
                      <option key={lvl} value={lvl}>
                        {lvl}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            )}

            <div className="text-xs font-semibold text-[var(--text-secondary)] tabular-nums">
              Matching active cards: {customPreviewCount}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowCustomModal(false)}
                className="min-h-[42px] px-4 py-2 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={customPreviewCount === 0}
                onClick={startCustomStudy}
                className="min-h-[42px] px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold"
              >
                Start ({customPreviewCount})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
