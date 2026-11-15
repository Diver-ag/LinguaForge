import {
  DefaultScheduler,
  Rating,
  State,
  type Grade,
} from 'ts-fsrs';
import { db, type CardItem, type DeckItem, type ReviewLogItem } from '../db/db';
import { ensureDefaultDeck, generateEntityId } from '../db/cards';
import {
  getEffectiveDeckLimits,
  getStudyDayBounds,
  type StudySettings,
} from './studySettings';

export { Rating, State, type Grade };

export const RATING_LABELS: Record<Grade, string> = {
  [Rating.Again]: 'Again',
  [Rating.Hard]: 'Hard',
  [Rating.Good]: 'Good',
  [Rating.Easy]: 'Easy',
};

export const STATE_LABELS: Record<number, string> = {
  [State.New]: 'New',
  [State.Learning]: 'Learning',
  [State.Review]: 'Review',
  [State.Relearning]: 'Relearning',
};

type FSRS6Scheduler = DefaultScheduler<'FSRS-6'>;
const schedulerCache = new Map<string, Promise<FSRS6Scheduler>>();

export function getScheduler(settings: StudySettings): Promise<FSRS6Scheduler> {
  const key = `${settings.desiredRetention}|${settings.maximumInterval}|${settings.enableFuzz}`;
  let cached = schedulerCache.get(key);
  if (!cached) {
    cached = DefaultScheduler({
      version: 'FSRS-6',
      desiredRetention: settings.desiredRetention,
      maximumInterval: settings.maximumInterval,
      enableFuzz: settings.enableFuzz,
      enableShortTerm: true,
      learningSteps: ['1m', '10m'],
      relearningSteps: ['10m'],
    });
    schedulerCache.set(key, cached);
  }
  return cached;
}

function toScheduleStatus(state: number): 'new' | 'learning' | 'review' {
  if (state === State.New) return 'new';
  if (state === State.Review) return 'review';
  return 'learning';
}

export function toSchedulerCard(
  scheduler: FSRS6Scheduler,
  card: CardItem,
  now: Date
) {
  const state = (card.state ?? State.New) as State;
  const base = scheduler.newCard({ now, cardId: card.id });

  if (state === State.New && !card.lastReview && (card.reps ?? 0) === 0) {
    return base;
  }

  return {
    ...base,
    cardId: card.id,
    state,
    scheduleStatus: toScheduleStatus(state),
    stability: card.stability ?? 0,
    difficulty: card.difficulty ?? 0,
    reps: card.reps ?? 0,
    lapses: card.lapses ?? 0,
    scheduledDays: card.scheduledDays ?? 0,
    learningStep: card.learningSteps ?? 0,
    dueAt: new Date(card.due ?? now.getTime()),
    lastReviewAt: card.lastReview ? new Date(card.lastReview) : null,
  };
}

export function formatIntervalText(
  dueAt: Date,
  now: Date,
  scheduledDays: number
): string {
  const diffMs = Math.max(0, dueAt.getTime() - now.getTime());
  const diffMinutes = Math.round(diffMs / 60_000);
  const diffHours = diffMs / 3_600_000;

  if (scheduledDays >= 1 || diffHours >= 23.5) {
    const days = Math.max(1, scheduledDays >= 1 ? Math.round(scheduledDays) : Math.round(diffMs / 86_400_000));
    if (days < 30) return `${days}d`;
    if (days < 365) {
      const months = (days / 30).toFixed(1).replace(/\.0$/, '');
      return `${months}mo`;
    }
    const years = (days / 365).toFixed(1).replace(/\.0$/, '');
    return `${years}y`;
  }

  if (diffMinutes < 1) return '<1m';
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const hours = Math.max(1, Math.round(diffHours));
  return `${hours}h`;
}

export interface RatingPreviewOption {
  grade: Grade;
  label: string;
  intervalText: string;
  dueAt: Date;
  scheduledDays: number;
}

export async function previewCardRatings(
  card: CardItem,
  settings: StudySettings,
  now: Date = new Date()
): Promise<RatingPreviewOption[]> {
  const scheduler = await getScheduler(settings);
  const inputCard = toSchedulerCard(scheduler, card, now);
  const items = Array.from(scheduler.preview({ card: inputCard, now }));

  const order: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
  return order.map((grade) => {
    const found = items.find((it) => it.grade === grade) || items[0];
    const nextDue = found.card.dueAt;
    const scheduledDays = found.card.scheduledDays ?? 0;
    return {
      grade,
      label: RATING_LABELS[grade],
      intervalText: formatIntervalText(nextDue, now, scheduledDays),
      dueAt: nextDue,
      scheduledDays,
    };
  });
}

export interface AnswerCardResult {
  updatedCard: CardItem;
  reviewLog: ReviewLogItem;
  previousSnapshot: CardItem;
  triggeredLeech: boolean;
}

export async function answerCard(params: {
  card: CardItem;
  rating: Grade;
  elapsedMs: number;
  settings: StudySettings;
  now?: Date;
  isCustomStudy?: boolean;
}): Promise<AnswerCardResult> {
  const now = params.now || new Date();
  const nowMs = now.getTime();
  const previousSnapshot: CardItem = {
    ...params.card,
    tags: [...(params.card.tags || [])],
  };

  const previousState = params.card.state ?? State.New;
  const previousLapses = params.card.lapses ?? 0;
  const elapsedDays = params.card.lastReview
    ? Math.max(0, (nowMs - params.card.lastReview) / 86_400_000)
    : 0;

  const scheduler = await getScheduler(params.settings);
  const inputCard = toSchedulerCard(scheduler, params.card, now);
  const result = scheduler.review({ card: inputCard, now, grade: params.rating });
  const nextFsrsCard = result.card;

  const nextLapses = nextFsrsCard.lapses ?? previousLapses;
  const lapsedThisReview =
    nextLapses > previousLapses ||
    (previousState === State.Review && params.rating === Rating.Again);

  let nextTags = [...(params.card.tags || [])];
  let triggeredLeech = false;
  if (lapsedThisReview && nextLapses >= params.settings.leechThreshold) {
    triggeredLeech = true;
    if (!nextTags.includes('leech')) {
      nextTags = [...nextTags, 'leech'];
    }
  }

  const updatedCard: CardItem = {
    ...params.card,
    tags: nextTags,
    due: nextFsrsCard.dueAt.getTime(),
    stability: nextFsrsCard.stability,
    difficulty: nextFsrsCard.difficulty,
    reps: nextFsrsCard.reps,
    lapses: nextLapses,
    state: nextFsrsCard.state,
    lastReview: nowMs,
    scheduledDays: nextFsrsCard.scheduledDays ?? 0,
    elapsedDays,
    learningSteps: nextFsrsCard.learningStep ?? 0,
    updatedAt: nowMs,
  };

  const reviewLog: ReviewLogItem = {
    id: generateEntityId('rev'),
    cardId: params.card.id,
    deckId: params.card.deckId,
    languageId: params.card.languageId,
    rating: params.rating,
    reviewedAt: nowMs,
    elapsed: Math.max(0, Math.round(params.elapsedMs)),
    previousState,
    state: nextFsrsCard.state,
    scheduledDays: nextFsrsCard.scheduledDays ?? 0,
    previousDue: params.card.due,
    newDue: nextFsrsCard.dueAt.getTime(),
    isCustomStudy: Boolean(params.isCustomStudy),
  };

  await db.transaction('rw', [db.cards, db.reviewLogs], async () => {
    await db.cards.put(updatedCard);
    await db.reviewLogs.put(reviewLog);
  });

  return {
    updatedCard,
    reviewLog,
    previousSnapshot,
    triggeredLeech,
  };
}

export async function undoReview(params: {
  previousSnapshot: CardItem;
  reviewLogId: string;
}): Promise<CardItem> {
  await db.transaction('rw', [db.cards, db.reviewLogs], async () => {
    await db.cards.put(params.previousSnapshot);
    await db.reviewLogs.delete(params.reviewLogId);
  });
  return params.previousSnapshot;
}

export async function buryCard(
  cardId: string,
  resetHour: number,
  nowMs: number = Date.now()
): Promise<void> {
  const { nextDayStartMs } = getStudyDayBounds(nowMs, resetHour);
  await db.cards.update(cardId, {
    buried: true,
    buriedUntil: nextDayStartMs,
    updatedAt: nowMs,
  });
}

export async function suspendCard(cardId: string, suspended = true): Promise<void> {
  await db.cards.update(cardId, {
    suspended,
    updatedAt: Date.now(),
  });
}

export async function unburyAllCards(languageId: string, deckId?: string): Promise<number> {
  const cards = await db.cards.where('languageId').equals(languageId).toArray();
  const buriedCards = cards.filter(
    (c) => c.buried && (!deckId || c.deckId === deckId)
  );
  if (buriedCards.length === 0) return 0;

  const now = Date.now();
  await db.cards.bulkPut(
    buriedCards.map((c) => ({
      ...c,
      buried: false,
      buriedUntil: undefined,
      updatedAt: now,
    }))
  );
  return buriedCards.length;
}

export async function unburyExpiredCards(
  languageId: string,
  nowMs: number = Date.now()
): Promise<number> {
  const cards = await db.cards.where('languageId').equals(languageId).toArray();
  const expired = cards.filter(
    (c) => c.buried && c.buriedUntil !== undefined && nowMs >= c.buriedUntil
  );
  if (expired.length === 0) return 0;

  await db.cards.bulkPut(
    expired.map((c) => ({
      ...c,
      buried: false,
      buriedUntil: undefined,
    }))
  );
  return expired.length;
}

function isCardActivelyBuried(card: CardItem, nowMs: number): boolean {
  if (!card.buried) return false;
  if (card.buriedUntil !== undefined && nowMs >= card.buriedUntil) return false;
  return true;
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function interleaveEvenly(reviews: CardItem[], newCards: CardItem[]): CardItem[] {
  if (newCards.length === 0) return [...reviews];
  if (reviews.length === 0) return [...newCards];

  const total = reviews.length + newCards.length;
  const result: CardItem[] = [];
  const step = total / newCards.length;
  let rIdx = 0;
  let nIdx = 0;
  let nextNewSlot = step / 2;

  for (let i = 0; i < total; i++) {
    if (nIdx < newCards.length && (i + 0.5 >= nextNewSlot || rIdx >= reviews.length)) {
      result.push(newCards[nIdx++]);
      nextNewSlot += step;
    } else if (rIdx < reviews.length) {
      result.push(reviews[rIdx++]);
    }
  }
  return result;
}

export interface DeckQueueSummary {
  deck: DeckItem;
  totalCards: number;
  newCount: number;
  totalNewInDeck: number;
  learningCount: number;
  dueReviewCount: number;
  totalDue: number;
  buriedCount: number;
  suspendedCount: number;
  newStudiedToday: number;
  reviewsDoneToday: number;
  newDailyLimit: number;
  reviewDailyLimit: number;
  nextDueAt: number | null;
}

export async function getDeckQueueSummaries(
  languageId: string,
  globalSettings: StudySettings,
  nowMs: number = Date.now()
): Promise<{
  summaries: DeckQueueSummary[];
  earliestNextDueAt: number | null;
  totalBuriedCount: number;
}> {
  await ensureDefaultDeck(languageId);
  await unburyExpiredCards(languageId, nowMs);

  const { dayStartMs, nextDayStartMs } = getStudyDayBounds(nowMs, globalSettings.dayResetHour);

  const [decks, cards, dayLogs] = await Promise.all([
    db.decks.where('languageId').equals(languageId).toArray(),
    db.cards.where('languageId').equals(languageId).toArray(),
    db.reviewLogs
      .where('reviewedAt')
      .aboveOrEqual(dayStartMs)
      .filter((l) => l.languageId === languageId && !l.isCustomStudy)
      .toArray(),
  ]);

  decks.sort((a, b) => {
    const aIsDefault = a.id === `default-${languageId}` ? 0 : 1;
    const bIsDefault = b.id === `default-${languageId}` ? 0 : 1;
    if (aIsDefault !== bIsDefault) return aIsDefault - bIsDefault;
    return a.createdAt - b.createdAt;
  });

  const logsByDeck = new Map<string, ReviewLogItem[]>();
  const cardById = new Map<string, CardItem>();
  for (const c of cards) cardById.set(c.id, c);

  for (const log of dayLogs) {
    const dId = log.deckId || cardById.get(log.cardId)?.deckId || `default-${languageId}`;
    const arr = logsByDeck.get(dId) || [];
    arr.push(log);
    logsByDeck.set(dId, arr);
  }

  let earliestNextDueAt: number | null = null;
  let totalBuriedCount = 0;

  const summaries: DeckQueueSummary[] = decks.map((deck) => {
    const deckCards = cards.filter((c) => c.deckId === deck.id);
    const deckLogs = logsByDeck.get(deck.id) || [];
    const limits = getEffectiveDeckLimits(deck, globalSettings);

    const newCardIdsToday = new Set(
      deckLogs.filter((l) => l.previousState === State.New).map((l) => l.cardId)
    );
    const newStudiedToday = newCardIdsToday.size;
    const reviewsDoneToday = deckLogs.filter((l) => l.previousState === State.Review).length;

    const remainingNewToday = Math.max(0, limits.newCardsPerDay - newStudiedToday);
    const remainingReviewsToday = Math.max(0, limits.maxReviewsPerDay - reviewsDoneToday);

    let suspendedCount = 0;
    let buriedCount = 0;
    const newCards: CardItem[] = [];
    const learningDue: CardItem[] = [];
    const reviewDue: CardItem[] = [];
    const futureDueTimes: number[] = [];

    for (const c of deckCards) {
      if (c.suspended) {
        suspendedCount += 1;
        continue;
      }
      if (isCardActivelyBuried(c, nowMs)) {
        buriedCount += 1;
        if (c.buriedUntil) futureDueTimes.push(c.buriedUntil);
        continue;
      }

      const st = c.state ?? State.New;
      const dueAt = c.due ?? c.createdAt ?? nowMs;

      if (st === State.New) {
        newCards.push(c);
      } else if (st === State.Learning || st === State.Relearning) {
        if (dueAt <= nowMs) {
          learningDue.push(c);
        } else {
          futureDueTimes.push(dueAt);
        }
      } else if (st === State.Review) {
        if (dueAt <= nowMs) {
          reviewDue.push(c);
        } else {
          futureDueTimes.push(
            remainingReviewsToday > 0 ? dueAt : Math.max(dueAt, nextDayStartMs)
          );
        }
      }
    }

    const newCount = Math.min(newCards.length, remainingNewToday);
    const dueReviewCount = Math.min(reviewDue.length, remainingReviewsToday);
    const learningCount = learningDue.length;
    const totalDue = newCount + learningCount + dueReviewCount;

    if (newCards.length > newCount && limits.newCardsPerDay > 0) {
      futureDueTimes.push(nextDayStartMs);
    }
    if (reviewDue.length > dueReviewCount && limits.maxReviewsPerDay > 0) {
      futureDueTimes.push(nextDayStartMs);
    }

    const nextDueAt =
      futureDueTimes.length > 0 ? Math.min(...futureDueTimes) : null;

    if (nextDueAt !== null && (earliestNextDueAt === null || nextDueAt < earliestNextDueAt)) {
      earliestNextDueAt = nextDueAt;
    }

    totalBuriedCount += buriedCount;

    return {
      deck,
      totalCards: deckCards.length,
      newCount,
      totalNewInDeck: newCards.length,
      learningCount,
      dueReviewCount,
      totalDue,
      buriedCount,
      suspendedCount,
      newStudiedToday,
      reviewsDoneToday,
      newDailyLimit: limits.newCardsPerDay,
      reviewDailyLimit: limits.maxReviewsPerDay,
      nextDueAt,
    };
  });

  return {
    summaries,
    earliestNextDueAt,
    totalBuriedCount,
  };
}

export async function buildDeckStudyQueue(
  deckId: string,
  languageId: string,
  globalSettings: StudySettings,
  nowMs: number = Date.now()
): Promise<{
  queue: CardItem[];
  deck: DeckItem;
  counts: { newCount: number; learningCount: number; reviewCount: number };
}> {
  await unburyExpiredCards(languageId, nowMs);
  const deck =
    (await db.decks.get(deckId)) || (await ensureDefaultDeck(languageId));
  const limits = getEffectiveDeckLimits(deck, globalSettings);
  const { dayStartMs } = getStudyDayBounds(nowMs, globalSettings.dayResetHour);

  const [deckCards, dayLogs] = await Promise.all([
    db.cards.where('deckId').equals(deck.id).toArray(),
    db.reviewLogs
      .where('reviewedAt')
      .aboveOrEqual(dayStartMs)
      .filter((l) => l.deckId === deck.id && !l.isCustomStudy)
      .toArray(),
  ]);

  const newStudiedToday = new Set(
    dayLogs.filter((l) => l.previousState === State.New).map((l) => l.cardId)
  ).size;
  const reviewsDoneToday = dayLogs.filter((l) => l.previousState === State.Review).length;

  const remainingNewToday = Math.max(0, limits.newCardsPerDay - newStudiedToday);
  const remainingReviewsToday = Math.max(0, limits.maxReviewsPerDay - reviewsDoneToday);

  const learningDue: CardItem[] = [];
  const reviewDue: CardItem[] = [];
  const newCandidates: CardItem[] = [];

  for (const c of deckCards) {
    if (c.suspended || isCardActivelyBuried(c, nowMs)) continue;
    const st = c.state ?? State.New;
    const dueAt = c.due ?? c.createdAt ?? nowMs;

    if (st === State.Learning || st === State.Relearning) {
      if (dueAt <= nowMs) learningDue.push(c);
    } else if (st === State.Review) {
      if (dueAt <= nowMs) reviewDue.push(c);
    } else {
      newCandidates.push(c);
    }
  }

  learningDue.sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
  reviewDue.sort((a, b) => (a.due ?? 0) - (b.due ?? 0));

  if (limits.newCardOrder === 'random') {
    shuffleInPlace(newCandidates);
  } else {
    newCandidates.sort((a, b) => a.createdAt - b.createdAt);
  }

  const selectedReviews = reviewDue.slice(0, remainingReviewsToday);
  const selectedNew = newCandidates.slice(0, remainingNewToday);

  let tail: CardItem[];
  if (globalSettings.newCardMix === 'first') {
    tail = [...selectedNew, ...selectedReviews];
  } else if (globalSettings.newCardMix === 'after') {
    tail = [...selectedReviews, ...selectedNew];
  } else {
    tail = interleaveEvenly(selectedReviews, selectedNew);
  }

  const queue = [...learningDue, ...tail];

  return {
    queue,
    deck,
    counts: {
      newCount: selectedNew.length,
      learningCount: learningDue.length,
      reviewCount: selectedReviews.length,
    },
  };
}

export type CustomStudyMode = 'ahead' | 'source' | 'tag' | 'level';

export async function buildCustomStudyQueue(
  params: {
    languageId: string;
    deckId?: string;
    mode: CustomStudyMode;
    aheadDays?: number;
    sourceDocTitle?: string;
    tag?: string;
    level?: string;
  },
  nowMs: number = Date.now()
): Promise<CardItem[]> {
  await unburyExpiredCards(params.languageId, nowMs);

  const cards = await db.cards
    .where('languageId')
    .equals(params.languageId)
    .toArray();

  const activeCards = cards.filter(
    (c) =>
      !c.suspended &&
      !isCardActivelyBuried(c, nowMs) &&
      (!params.deckId || params.deckId === 'all' || c.deckId === params.deckId)
  );

  if (params.mode === 'ahead') {
    const days = Math.max(0, params.aheadDays ?? 1);
    const cutoff = nowMs + days * 86_400_000;
    const dueAhead = activeCards.filter((c) => {
      const st = c.state ?? State.New;
      if (st === State.New) return false;
      return (c.due ?? nowMs) <= cutoff;
    });
    dueAhead.sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
    return dueAhead;
  }

  if (params.mode === 'source') {
    const target = (params.sourceDocTitle || '').trim();
    return activeCards
      .filter((c) => (c.sourceDocTitle || '').trim() === target)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  if (params.mode === 'tag') {
    const target = (params.tag || '').trim();
    return activeCards
      .filter((c) => (c.tags || []).includes(target))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  const targetLevel = (params.level || '').trim().toUpperCase();
  return activeCards
    .filter((c) => (c.level || '').trim().toUpperCase() === targetLevel)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function formatRelativeDueTime(
  dueMs: number,
  nowMs: number = Date.now()
): string {
  const diffMs = Math.max(0, dueMs - nowMs);
  const dueDate = new Date(dueMs);
  const timeStr = dueDate.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  if (diffMs < 60_000) {
    return `in less than a minute (${timeStr})`;
  }
  const diffMins = Math.round(diffMs / 60_000);
  if (diffMins < 60) {
    return `in ${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} (${timeStr})`;
  }
  const diffHours = Math.round(diffMs / 3_600_000);
  const nowDate = new Date(nowMs);
  const sameDay =
    nowDate.getFullYear() === dueDate.getFullYear() &&
    nowDate.getMonth() === dueDate.getMonth() &&
    nowDate.getDate() === dueDate.getDate();

  if (sameDay) {
    return `in ${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} (${timeStr})`;
  }

  const tomorrow = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1);
  const isTomorrow =
    tomorrow.getFullYear() === dueDate.getFullYear() &&
    tomorrow.getMonth() === dueDate.getMonth() &&
    tomorrow.getDate() === dueDate.getDate();

  if (isTomorrow) {
    return `tomorrow at ${timeStr}`;
  }

  const dateStr = dueDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `on ${dateStr} at ${timeStr}`;
}
