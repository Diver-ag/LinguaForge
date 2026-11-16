import { db, type CardItem, type DeckItem, type ReviewLogItem } from '../db/db';
import { Rating, State } from './fsrsScheduler';
import {
  DEMO_SYNTHETIC_META_KEY,
  formatLocalDateKey,
  getStudyDayBounds,
  getStudyDayKey,
  parseLocalDateKey,
  shiftLocalDateKey,
  type StudySettings,
} from './studySettings';
import { getStatsCacheVersion } from './statsCache';
import { getLanguagePack } from '../packs/registry';
import type { DemoSyntheticMeta } from './demoData';

export type StatsPeriod = '7d' | '30d' | '90d' | '1y' | 'all';

export interface StatsQueryOptions {
  languageId: string; // 'all' or pack id ('ja', 'es')
  deckId: string; // 'all' or specific deck id
  period: StatsPeriod;
  includeDemoData: boolean;
  studySettings: StudySettings;
  nowMs?: number;
}

export interface DailySeriesPoint {
  dateKey: string;
  label: string;
  reviews: number;
  newCards: number;
  reviewStateTotal: number;
  reviewStatePassed: number;
  retentionPct: number | null;
  studyMinutes: number;
  lookups: number;
}

export interface HeatmapCell {
  dateKey: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface RetentionPoint {
  dateKey: string;
  label: string;
  retentionPct: number;
  sampleCount: number;
}

export interface ForecastDay {
  dayOffset: number;
  dateKey: string;
  label: string;
  learningCount: number;
  reviewCount: number;
  totalDue: number;
  cumulativeDue: number;
}

export interface MaturityCounts {
  newCount: number;
  learningCount: number;
  youngCount: number;
  matureCount: number;
  suspendedCount: number;
  totalCards: number;
}

export interface IntervalBucket {
  label: string;
  count: number;
}

export interface WordsLearnedPoint {
  dateKey: string;
  label: string;
  matureCards: number;
  knownWords: number;
}

export interface HardCardSummary {
  id: string;
  word: string;
  reading: string;
  meaning: string;
  lapses: number;
  stability: number;
  reps: number;
  tags: string[];
  suspended: boolean;
  isDemo: boolean;
  cardRef?: CardItem;
}

export interface LevelProgressRow {
  code: string;
  label: string;
  isNoLevel: boolean;
  wordsKnownOrLearned: number;
  wordsImportedTotal: number;
  kanjiKnownOrLearned: number;
  kanjiImportedTotal: number;
}

export interface TopLookupRow {
  word: string;
  reading?: string;
  meaning?: string;
  count: number;
  hasCard: boolean;
}

export interface DashboardStats {
  generatedAt: number;
  totalMatchingLogs: number;
  hasAnyLogs: boolean;
  hasDemoLogsIncluded: boolean;
  today: {
    reviews: number;
    newCardsLearned: number;
    timeMs: number;
    accuracyPct: number | null;
    dailyGoal: number;
  };
  streaks: {
    currentStreak: number;
    longestStreak: number;
    daysThisMonth: number;
    minReviewsPerDay: number;
    streakFreezeEnabled: boolean;
    freezesUsedThisWeek: number;
  };
  heatmap: {
    cells: HeatmapCell[];
    maxCount: number;
    totalYearReviews: number;
    startDateKey: string;
    endDateKey: string;
  };
  retention: {
    reviewStateTotal: number;
    reviewStatePassed: number;
    trueRetentionPct: number | null;
    desiredRetentionPct: number;
    hasEnoughData: boolean;
    series: RetentionPoint[];
  };
  answerBreakdown: {
    total: number;
    ratings: {
      rating: number;
      label: string;
      count: number;
      pct: number;
    }[];
    byState: {
      stateLabel: string;
      total: number;
      again: number;
      hard: number;
      good: number;
      easy: number;
      passPct: number | null;
    }[];
  };
  forecast: {
    days: ForecastDay[];
    dueTomorrow: number;
    dueThisWeek: number;
    totalScheduled: number;
  };
  maturity: MaturityCounts;
  intervalHistogram: IntervalBucket[];
  wordsLearned: {
    series: WordsLearnedPoint[];
    totalMature: number;
    totalKnownWords: number;
  };
  studyTime: {
    daily: { dateKey: string; label: string; minutes: number }[];
    totalMinutes: number;
    avgMinutesPerActiveDay: number;
    avgMinutesPerPeriodDay: number;
    activeDays: number;
  };
  hardestCards: HardCardSummary[];
  leechCards: HardCardSummary[];
  levelProgress: {
    systemName: string;
    supportsKanji: boolean;
    hasImportedVocab: boolean;
    hasImportedKanji: boolean;
    rows: LevelProgressRow[];
  };
  lookups: {
    daily: { dateKey: string; label: string; count: number }[];
    topWords: TopLookupRow[];
    totalUniqueLookedUp: number;
    convertedToCardsCount: number;
    conversionPct: number;
  };
  csvDailySeries: DailySeriesPoint[];
  allDecks: DeckItem[];
}

const statsCache = new Map<string, DashboardStats>();

const PERIOD_DAYS: Record<StatsPeriod, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
  all: null,
};

function createFastStudyDayKeyFn(resetHour: number) {
  const safeReset = Math.min(23, Math.max(0, Math.round(resetHour)));
  const hourBucketCache = new Map<number, string>();
  return (ts: number): string => {
    const bucket = Math.floor(ts / 3_600_000);
    const hit = hourBucketCache.get(bucket);
    if (hit !== undefined) return hit;
    const key = getStudyDayKey(ts, safeReset);
    hourBucketCache.set(bucket, key);
    return key;
  };
}

function getIsoWeekKey(dateKey: string): string {
  const d = parseLocalDateKey(dateKey);
  const temp = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = temp.getDay() || 7; // Mon=1 .. Sun=7
  temp.setDate(temp.getDate() + 4 - day);
  const yearStart = new Date(temp.getFullYear(), 0, 1);
  const weekNo = Math.ceil(((temp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${temp.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function formatShortDate(dateKey: string): string {
  const [, m, d] = dateKey.split('-');
  return `${Number(m)}/${Number(d)}`;
}

async function queryReviewLogsFast(opts: {
  languageId: string;
  deckId: string;
  includeDemoData: boolean;
}): Promise<ReviewLogItem[]> {
  let raw: ReviewLogItem[];
  if (opts.deckId !== 'all') {
    raw = await db.reviewLogs.where('deckId').equals(opts.deckId).toArray();
  } else if (opts.languageId !== 'all') {
    raw = await db.reviewLogs.where('languageId').equals(opts.languageId).toArray();
  } else {
    raw = await db.reviewLogs.toArray();
  }

  if (opts.includeDemoData) {
    return raw;
  }
  return raw.filter((l) => !l.isDemo);
}

export async function getTodayReviewCount(
  languageId: string,
  studySettings: StudySettings,
  includeDemoData = false,
  nowMs = Date.now()
): Promise<number> {
  const { dayStartMs } = getStudyDayBounds(nowMs, studySettings.dayResetHour);
  let logs: ReviewLogItem[];
  if (languageId !== 'all') {
    logs = await db.reviewLogs
      .where('[languageId+reviewedAt]')
      .between([languageId, dayStartMs], [languageId, Number.MAX_SAFE_INTEGER], true, true)
      .toArray();
  } else {
    logs = await db.reviewLogs.where('reviewedAt').aboveOrEqual(dayStartMs).toArray();
  }
  if (includeDemoData) return logs.length;
  let count = 0;
  for (let i = 0; i < logs.length; i++) {
    if (!logs[i].isDemo) count++;
  }
  return count;
}

export async function computeDashboardStats(
  opts: StatsQueryOptions
): Promise<DashboardStats> {
  const nowMs = opts.nowMs ?? Date.now();
  const s = opts.studySettings;
  const cacheVersion = getStatsCacheVersion();
  const cacheKey = `${opts.languageId}|${opts.deckId}|${opts.period}|${opts.includeDemoData}|${s.dayResetHour}|${s.desiredRetention}|${s.dailyGoalReviews}|${s.streakMinReviews}|${s.streakFreezeEnabled}|${s.leechThreshold}|${cacheVersion}`;

  if (opts.nowMs === undefined) {
    const cached = statsCache.get(cacheKey);
    if (cached) return cached;
  }

  const getDayKey = createFastStudyDayKeyFn(s.dayResetHour);
  const todayKey = getDayKey(nowMs);
  const { dayStartMs: todayStartMs } = getStudyDayBounds(nowMs, s.dayResetHour);
  const periodDays = PERIOD_DAYS[opts.period];
  const periodStartKey =
    periodDays !== null ? shiftLocalDateKey(todayKey, -(periodDays - 1)) : null;

  // 1. Load metadata, cards, decks, logs, wordStatuses, lookups
  const [decks, realCards, logs, wordStatusesRaw, lookupsRaw, lookupEventsRaw, demoMetaItem] =
    await Promise.all([
      opts.languageId === 'all'
        ? db.decks.toArray()
        : db.decks.where('languageId').equals(opts.languageId).toArray(),
      opts.deckId !== 'all'
        ? db.cards.where('deckId').equals(opts.deckId).toArray()
        : opts.languageId !== 'all'
        ? db.cards.where('languageId').equals(opts.languageId).toArray()
        : db.cards.toArray(),
      queryReviewLogsFast(opts),
      opts.languageId === 'all'
        ? db.wordStatuses.toArray()
        : db.wordStatuses.where('languageId').equals(opts.languageId).toArray(),
      opts.languageId === 'all'
        ? db.lookups.toArray()
        : db.lookups.where('languageId').equals(opts.languageId).toArray(),
      db.eventLogs.where('type').equals('word_lookup').toArray(),
      opts.includeDemoData ? db.settings.get(DEMO_SYNTHETIC_META_KEY) : Promise.resolve(undefined),
    ]);

  const demoMeta =
    opts.includeDemoData && demoMetaItem?.value
      ? (demoMetaItem.value as DemoSyntheticMeta)
      : undefined;

  const demoMatchesFilter =
    Boolean(demoMeta) &&
    (opts.languageId === 'all' || demoMeta!.languageId === opts.languageId) &&
    (opts.deckId === 'all' || demoMeta!.deckId === opts.deckId);

  const cards: (CardItem & { __isDemo?: boolean })[] = [
    ...realCards,
    ...(demoMatchesFilter
      ? demoMeta!.cards.map((c) => ({ ...c, __isDemo: true }))
      : []),
  ];

  // Single pass aggregation over reviewLogs
  const dayCounts = new Map<string, number>();
  const dayNewCardIds = new Map<string, Set<string>>();
  const dayTimeMs = new Map<string, number>();
  const dayRetTotal = new Map<string, number>();
  const dayRetPass = new Map<string, number>();

  // Today metrics
  let todayReviews = 0;
  const todayNewCardSet = new Set<string>();
  let todayTimeMs = 0;
  let todayPassed = 0;

  // Period metrics
  let periodLogCount = 0;
  let periodRetTotal = 0;
  let periodRetPass = 0;
  const ratingCounts = [0, 0, 0, 0, 0]; // index 1..4
  const stateBreakdown = {
    new: { total: 0, again: 0, hard: 0, good: 0, easy: 0 },
    learning: { total: 0, again: 0, hard: 0, good: 0, easy: 0 },
    review: { total: 0, again: 0, hard: 0, good: 0, easy: 0 },
  };

  let earliestLogKey: string | null = null;
  let hasDemoLogsIncluded = false;
  const firstMatureKeyByCard = new Map<string, string>();

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    if (log.isDemo) hasDemoLogsIncluded = true;

    const dKey = getDayKey(log.reviewedAt);
    if (earliestLogKey === null || dKey < earliestLogKey) {
      earliestLogKey = dKey;
    }

    const cappedElapsed = Math.min(60_000, Math.max(0, log.elapsed || 0));

    // All-time daily counts (for heatmap + streaks)
    dayCounts.set(dKey, (dayCounts.get(dKey) || 0) + 1);

    // Track first mature milestone from logs
    if (
      log.state === State.Review &&
      log.scheduledDays >= 21 &&
      !firstMatureKeyByCard.has(log.cardId)
    ) {
      firstMatureKeyByCard.set(log.cardId, dKey);
    }

    // Today breakdown
    if (dKey === todayKey) {
      todayReviews += 1;
      todayTimeMs += cappedElapsed;
      if (log.previousState === State.New) todayNewCardSet.add(log.cardId);
      if (log.rating >= Rating.Hard) todayPassed += 1;
    }

    // Period filtering
    if (periodStartKey === null || (dKey >= periodStartKey && dKey <= todayKey)) {
      periodLogCount += 1;
      dayTimeMs.set(dKey, (dayTimeMs.get(dKey) || 0) + cappedElapsed);

      if (log.previousState === State.New) {
        let sSet = dayNewCardIds.get(dKey);
        if (!sSet) {
          sSet = new Set<string>();
          dayNewCardIds.set(dKey, sSet);
        }
        sSet.add(log.cardId);
      }

      if (log.rating >= 1 && log.rating <= 4) {
        ratingCounts[log.rating] += 1;
      }

      const stGroup =
        log.previousState === State.New
          ? stateBreakdown.new
          : log.previousState === State.Review
          ? stateBreakdown.review
          : stateBreakdown.learning;

      stGroup.total += 1;
      if (log.rating === Rating.Again) stGroup.again += 1;
      else if (log.rating === Rating.Hard) stGroup.hard += 1;
      else if (log.rating === Rating.Good) stGroup.good += 1;
      else if (log.rating === Rating.Easy) stGroup.easy += 1;

      if (log.previousState === State.Review) {
        periodRetTotal += 1;
        dayRetTotal.set(dKey, (dayRetTotal.get(dKey) || 0) + 1);
        if (log.rating >= Rating.Hard) {
          periodRetPass += 1;
          dayRetPass.set(dKey, (dayRetPass.get(dKey) || 0) + 1);
        }
      }
    }
  }

  // Merge demo mature dates if included
  if (demoMatchesFilter && demoMeta?.matureDatesByCardId) {
    for (const [cid, mDate] of Object.entries(demoMeta.matureDatesByCardId)) {
      if (!firstMatureKeyByCard.has(cid)) {
        firstMatureKeyByCard.set(cid, mDate);
      }
    }
  }

  // Fallback mature date for migrated/older cards whose mature log isn't present
  for (const c of cards) {
    if (
      !c.suspended &&
      c.state === State.Review &&
      (c.scheduledDays ?? 0) >= 21 &&
      !firstMatureKeyByCard.has(c.id)
    ) {
      const ts = c.lastReview || c.updatedAt || c.createdAt;
      firstMatureKeyByCard.set(c.id, getDayKey(ts));
    }
  }

  // 2. Streaks calculation
  const minRev = s.streakMinReviews;
  const freezeEnabled = s.streakFreezeEnabled;

  let currentStreak = 0;
  let freezesUsedThisWeek = 0;
  const todayCount = dayCounts.get(todayKey) || 0;
  const currentWeekKey = getIsoWeekKey(todayKey);

  if (earliestLogKey) {
    let cursor = todayCount >= minRev ? todayKey : shiftLocalDateKey(todayKey, -1);
    const usedFreezeWeeks = new Map<string, number>();

    while (cursor >= earliestLogKey) {
      const cCount = dayCounts.get(cursor) || 0;
      if (cCount >= minRev) {
        currentStreak += 1;
        cursor = shiftLocalDateKey(cursor, -1);
      } else if (freezeEnabled) {
        const wk = getIsoWeekKey(cursor);
        const used = usedFreezeWeeks.get(wk) || 0;
        const prevCursor = shiftLocalDateKey(cursor, -1);
        const prevCount = dayCounts.get(prevCursor) || 0;
        if (used < 1 && prevCursor >= earliestLogKey && prevCount >= minRev) {
          usedFreezeWeeks.set(wk, used + 1);
          cursor = prevCursor;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    freezesUsedThisWeek = usedFreezeWeeks.get(currentWeekKey) || 0;
  }

  // Longest streak (chronological forward pass from earliest active day)
  let longestStreak = 0;
  if (earliestLogKey) {
    let run = 0;
    const usedWeeksLongest = new Map<string, number>();
    let cursor = earliestLogKey;
    while (cursor <= todayKey) {
      const cCount = dayCounts.get(cursor) || 0;
      if (cCount >= minRev) {
        run += 1;
        if (run > longestStreak) longestStreak = run;
      } else if (freezeEnabled && run > 0) {
        const wk = getIsoWeekKey(cursor);
        const used = usedWeeksLongest.get(wk) || 0;
        const nextCursor = shiftLocalDateKey(cursor, 1);
        const nextCount = nextCursor <= todayKey ? dayCounts.get(nextCursor) || 0 : 0;
        if (used < 1 && nextCount >= minRev) {
          usedWeeksLongest.set(wk, used + 1);
          if (wk === currentWeekKey) {
            freezesUsedThisWeek = Math.max(freezesUsedThisWeek, 1);
          }
        } else {
          run = 0;
        }
      } else {
        run = 0;
      }
      cursor = shiftLocalDateKey(cursor, 1);
    }
  }

  const monthPrefix = todayKey.slice(0, 7); // YYYY-MM
  let daysThisMonth = 0;
  for (const [dKey, count] of dayCounts.entries()) {
    if (dKey.startsWith(monthPrefix) && count >= minRev) {
      daysThisMonth += 1;
    }
  }

  // 3. Review Heatmap (last 52-53 weeks aligned to Sunday start -> today)
  const todayDate = parseLocalDateKey(todayKey);
  const rawStart = new Date(todayDate);
  rawStart.setDate(rawStart.getDate() - 364);
  // Align back to Sunday (0)
  rawStart.setDate(rawStart.getDate() - rawStart.getDay());
  const heatmapStartKey = formatLocalDateKey(rawStart);

  const heatmapRawCells: { dateKey: string; count: number }[] = [];
  let maxHeatmapCount = 0;
  let totalYearReviews = 0;
  {
    let cur = heatmapStartKey;
    while (cur <= todayKey) {
      const cnt = dayCounts.get(cur) || 0;
      if (cnt > maxHeatmapCount) maxHeatmapCount = cnt;
      totalYearReviews += cnt;
      heatmapRawCells.push({ dateKey: cur, count: cnt });
      cur = shiftLocalDateKey(cur, 1);
    }
  }

  const heatmapCells: HeatmapCell[] = heatmapRawCells.map(({ dateKey, count }) => {
    let level: 0 | 1 | 2 | 3 | 4 = 0;
    if (count > 0) {
      if (maxHeatmapCount <= 4) {
        level = Math.min(4, count) as 1 | 2 | 3 | 4;
      } else {
        const ratio = count / maxHeatmapCount;
        if (ratio <= 0.25) level = 1;
        else if (ratio <= 0.5) level = 2;
        else if (ratio <= 0.75) level = 3;
        else level = 4;
      }
    }
    return { dateKey, count, level };
  });

  // 4. Period timeline date keys
  const seriesStartKey =
    periodStartKey ??
    (earliestLogKey && earliestLogKey <= todayKey
      ? earliestLogKey
      : shiftLocalDateKey(todayKey, -29));

  const timelineKeys: string[] = [];
  {
    let cur = seriesStartKey;
    // Cap Safety for extremely distant timestamps
    const maxLoop = 3650;
    let guard = 0;
    while (cur <= todayKey && guard < maxLoop) {
      timelineKeys.push(cur);
      cur = shiftLocalDateKey(cur, 1);
      guard += 1;
    }
  }

  // 5. Lookups aggregation (daily + top 10 + conversion to cards)
  const lookupWordMap = new Map<
    string,
    { word: string; reading?: string; meaning?: string; count: number }
  >();
  for (const l of lookupsRaw) {
    const existing = lookupWordMap.get(l.word);
    if (existing) {
      existing.count += l.count;
    } else {
      lookupWordMap.set(l.word, {
        word: l.word,
        reading: l.reading,
        meaning: l.meaning,
        count: l.count,
      });
    }
  }
  if (demoMatchesFilter && demoMeta?.lookups) {
    for (const dl of demoMeta.lookups) {
      const existing = lookupWordMap.get(dl.word);
      if (existing) {
        existing.count += dl.count;
      } else {
        lookupWordMap.set(dl.word, {
          word: dl.word,
          reading: dl.reading,
          meaning: dl.meaning,
          count: dl.count,
        });
      }
    }
  }

  const cardWordSet = new Set<string>();
  for (const c of cards) {
    if (c.word) cardWordSet.add(c.word);
    if (c.lemma) cardWordSet.add(c.lemma);
  }
  if (demoMatchesFilter && demoMeta?.lookups) {
    for (const dl of demoMeta.lookups) {
      if (dl.hasCard) cardWordSet.add(dl.word);
    }
  }

  const topLookupRows: TopLookupRow[] = Array.from(lookupWordMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((item) => ({
      ...item,
      hasCard: cardWordSet.has(item.word),
    }));

  const totalUniqueLookedUp = lookupWordMap.size;
  let convertedToCardsCount = 0;
  for (const word of lookupWordMap.keys()) {
    if (cardWordSet.has(word)) convertedToCardsCount += 1;
  }
  const conversionPct =
    totalUniqueLookedUp > 0
      ? Math.round((convertedToCardsCount / totalUniqueLookedUp) * 100)
      : 0;

  // Daily lookup counts from eventLogs + fallback + demo lookups
  const dailyLookupCounts = new Map<string, number>();
  const languageLookupWords = new Set(lookupsRaw.map((l) => l.word));
  let matchedEventsCount = 0;

  for (const ev of lookupEventsRaw) {
    const evLang = ev.payload?.langId;
    const evWord = ev.payload?.word;
    if (opts.languageId !== 'all') {
      if (evLang && evLang !== opts.languageId) continue;
      if (!evLang && evWord && !languageLookupWords.has(evWord)) continue;
    }
    const dKey = getDayKey(ev.timestamp);
    if (dKey >= seriesStartKey && dKey <= todayKey) {
      dailyLookupCounts.set(dKey, (dailyLookupCounts.get(dKey) || 0) + 1);
      matchedEventsCount += 1;
    }
  }
  if (matchedEventsCount === 0 && lookupsRaw.length > 0) {
    for (const l of lookupsRaw) {
      const dKey = getDayKey(l.timestamp);
      if (dKey >= seriesStartKey && dKey <= todayKey) {
        dailyLookupCounts.set(dKey, (dailyLookupCounts.get(dKey) || 0) + l.count);
      }
    }
  }
  if (demoMatchesFilter && demoMeta?.lookups) {
    for (const dl of demoMeta.lookups) {
      for (const [dKey, cnt] of Object.entries(dl.dailyCounts || {})) {
        if (dKey >= seriesStartKey && dKey <= todayKey) {
          dailyLookupCounts.set(dKey, (dailyLookupCounts.get(dKey) || 0) + cnt);
        }
      }
    }
  }

  // 6. Retention points (only computed when reviewStateTotal >= 30)
  const retentionSeries: RetentionPoint[] = [];
  const hasEnoughRetentionData = periodRetTotal >= 30;
  if (hasEnoughRetentionData) {
    // Group into weekly buckets if > 95 days to keep SVG legible
    if (timelineKeys.length > 95) {
      const weekBuckets = new Map<string, { firstKey: string; pass: number; total: number }>();
      for (const dKey of timelineKeys) {
        const tot = dayRetTotal.get(dKey) || 0;
        if (tot === 0) continue;
        const pass = dayRetPass.get(dKey) || 0;
        const wk = getIsoWeekKey(dKey);
        const b = weekBuckets.get(wk) || { firstKey: dKey, pass: 0, total: 0 };
        b.pass += pass;
        b.total += tot;
        weekBuckets.set(wk, b);
      }
      for (const b of weekBuckets.values()) {
        retentionSeries.push({
          dateKey: b.firstKey,
          label: formatShortDate(b.firstKey),
          retentionPct: Number(((b.pass / b.total) * 100).toFixed(1)),
          sampleCount: b.total,
        });
      }
    } else {
      for (const dKey of timelineKeys) {
        const tot = dayRetTotal.get(dKey) || 0;
        if (tot === 0) continue;
        const pass = dayRetPass.get(dKey) || 0;
        retentionSeries.push({
          dateKey: dKey,
          label: formatShortDate(dKey),
          retentionPct: Number(((pass / tot) * 100).toFixed(1)),
          sampleCount: tot,
        });
      }
    }
  }

  // 7. Answer breakdown
  const ratingLabels = ['', 'Again', 'Hard', 'Good', 'Easy'];
  const ratings = [1, 2, 3, 4].map((r) => ({
    rating: r,
    label: ratingLabels[r],
    count: ratingCounts[r],
    pct: periodLogCount > 0 ? Math.round((ratingCounts[r] / periodLogCount) * 100) : 0,
  }));

  const toStateRow = (
    stateLabel: string,
    b: { total: number; again: number; hard: number; good: number; easy: number }
  ) => ({
    stateLabel,
    ...b,
    passPct: b.total > 0 ? Math.round(((b.total - b.again) / b.total) * 100) : null,
  });

  // 8. Forecast (next 30 days)
  const forecastMap = new Map<number, { learning: number; review: number }>();
  for (let i = 0; i < 30; i++) forecastMap.set(i, { learning: 0, review: 0 });
  let totalScheduledForecast = 0;

  for (const c of cards) {
    if (c.suspended) continue;
    const st = c.state ?? State.New;
    if (st === State.New) continue;
    const dueAt = c.due ?? todayStartMs;
    const offset = Math.max(0, Math.floor((dueAt - todayStartMs) / 86_400_000));
    if (offset < 30) {
      const slot = forecastMap.get(offset)!;
      if (st === State.Review) slot.review += 1;
      else slot.learning += 1;
      totalScheduledForecast += 1;
    }
  }

  const forecastDays: ForecastDay[] = [];
  let runningDue = 0;
  let dueTomorrow = 0;
  let dueThisWeek = 0;
  for (let i = 0; i < 30; i++) {
    const slot = forecastMap.get(i)!;
    const totalDue = slot.learning + slot.review;
    runningDue += totalDue;
    const dKey = shiftLocalDateKey(todayKey, i);
    if (i === 1) dueTomorrow = totalDue;
    if (i >= 0 && i < 7) dueThisWeek += totalDue;
    forecastDays.push({
      dayOffset: i,
      dateKey: dKey,
      label: i === 0 ? 'Today' : i === 1 ? 'Tmrw' : formatShortDate(dKey),
      learningCount: slot.learning,
      reviewCount: slot.review,
      totalDue,
      cumulativeDue: runningDue,
    });
  }

  // 9. Card Maturity & Interval Distribution Histogram
  const maturity: MaturityCounts = {
    newCount: 0,
    learningCount: 0,
    youngCount: 0,
    matureCount: 0,
    suspendedCount: 0,
    totalCards: cards.length,
  };

  const intervalBuckets = [
    { label: '<1d', min: 0, max: 0.9999, count: 0 },
    { label: '1-3d', min: 1, max: 3, count: 0 },
    { label: '4-7d', min: 4, max: 7, count: 0 },
    { label: '8-20d', min: 8, max: 20, count: 0 },
    { label: '21-60d', min: 21, max: 60, count: 0 },
    { label: '61-180d', min: 61, max: 180, count: 0 },
    { label: '180d+', min: 181, max: Infinity, count: 0 },
  ];

  for (const c of cards) {
    if (c.suspended) {
      maturity.suspendedCount += 1;
      continue;
    }
    const st = c.state ?? State.New;
    const sched = c.scheduledDays ?? 0;
    if (st === State.New) {
      maturity.newCount += 1;
    } else if (st === State.Learning || st === State.Relearning) {
      maturity.learningCount += 1;
      intervalBuckets[0].count += 1;
    } else if (sched >= 21) {
      maturity.matureCount += 1;
      for (const b of intervalBuckets) {
        if (sched >= b.min && sched <= b.max) {
          b.count += 1;
          break;
        }
      }
    } else {
      maturity.youngCount += 1;
      const eff = Math.max(0, sched);
      for (const b of intervalBuckets) {
        if (eff >= b.min && eff <= b.max) {
          b.count += 1;
          break;
        }
      }
    }
  }

  // 10. Words Learned Over Time (Mature cards + Words marked Known)
  const matureByDay = new Map<string, number>();
  for (const dKey of firstMatureKeyByCard.values()) {
    matureByDay.set(dKey, (matureByDay.get(dKey) || 0) + 1);
  }

  const knownWordDates = new Map<string, string>();
  for (const ws of wordStatusesRaw) {
    if (ws.status === 'known') {
      knownWordDates.set(ws.word, getDayKey(ws.updatedAt));
    }
  }
  if (demoMatchesFilter && demoMeta?.wordStatuses) {
    for (const dws of demoMeta.wordStatuses) {
      if (dws.status === 'known' && !knownWordDates.has(dws.word)) {
        knownWordDates.set(dws.word, getDayKey(dws.updatedAt));
      }
    }
  }
  const knownByDay = new Map<string, number>();
  for (const dKey of knownWordDates.values()) {
    knownByDay.set(dKey, (knownByDay.get(dKey) || 0) + 1);
  }

  // Accumulate from before seriesStartKey so cumulative line starts at accurate baseline
  let cumMature = 0;
  let cumKnown = 0;
  for (const [dKey, cnt] of matureByDay.entries()) {
    if (dKey < seriesStartKey) cumMature += cnt;
  }
  for (const [dKey, cnt] of knownByDay.entries()) {
    if (dKey < seriesStartKey) cumKnown += cnt;
  }

  const wordsLearnedSeries: WordsLearnedPoint[] = [];
  for (const dKey of timelineKeys) {
    cumMature += matureByDay.get(dKey) || 0;
    cumKnown += knownByDay.get(dKey) || 0;
    wordsLearnedSeries.push({
      dateKey: dKey,
      label: formatShortDate(dKey),
      matureCards: cumMature,
      knownWords: cumKnown,
    });
  }

  // 11. Study Time & Lookups Daily & CSV Daily Series
  let totalStudyMinutes = 0;
  let activeStudyDays = 0;
  const studyTimeDaily: { dateKey: string; label: string; minutes: number }[] = [];
  const lookupsDaily: { dateKey: string; label: string; count: number }[] = [];
  const csvDailySeries: DailySeriesPoint[] = [];

  for (const dKey of timelineKeys) {
    const mins = Number(((dayTimeMs.get(dKey) || 0) / 60_000).toFixed(2));
    const revCount = dayCounts.get(dKey) || 0;
    const newCount = dayNewCardIds.get(dKey)?.size || 0;
    const rTot = dayRetTotal.get(dKey) || 0;
    const rPass = dayRetPass.get(dKey) || 0;
    const lCount = dailyLookupCounts.get(dKey) || 0;

    if (mins > 0 || revCount > 0) activeStudyDays += 1;
    totalStudyMinutes += mins;

    studyTimeDaily.push({ dateKey: dKey, label: formatShortDate(dKey), minutes: mins });
    lookupsDaily.push({ dateKey: dKey, label: formatShortDate(dKey), count: lCount });
    csvDailySeries.push({
      dateKey: dKey,
      label: formatShortDate(dKey),
      reviews: revCount,
      newCards: newCount,
      reviewStateTotal: rTot,
      reviewStatePassed: rPass,
      retentionPct: rTot > 0 ? Number(((rPass / rTot) * 100).toFixed(1)) : null,
      studyMinutes: mins,
      lookups: lCount,
    });
  }

  // 12. Hardest Cards & Leeches
  const reviewedOrLapsed = cards.filter((c) => (c.reps ?? 0) > 0 || (c.lapses ?? 0) > 0);
  reviewedOrLapsed.sort((a, b) => {
    const lapseDiff = (b.lapses ?? 0) - (a.lapses ?? 0);
    if (lapseDiff !== 0) return lapseDiff;
    return (a.stability ?? 0) - (b.stability ?? 0);
  });

  const toHardSummary = (c: CardItem & { __isDemo?: boolean }): HardCardSummary => ({
    id: c.id,
    word: c.word,
    reading: c.reading,
    meaning: c.meaning,
    lapses: c.lapses ?? 0,
    stability: Number((c.stability ?? 0).toFixed(1)),
    reps: c.reps ?? 0,
    tags: c.tags || [],
    suspended: Boolean(c.suspended),
    isDemo: Boolean(c.__isDemo),
    cardRef: c.__isDemo ? undefined : c,
  });

  const hardestCards = reviewedOrLapsed.slice(0, 10).map(toHardSummary);
  const leechCards = cards
    .filter(
      (c) =>
        (c.tags || []).includes('leech') || (c.lapses ?? 0) >= s.leechThreshold
    )
    .sort((a, b) => (b.lapses ?? 0) - (a.lapses ?? 0))
    .map(toHardSummary);

  // 13. Progress by Level (strictly using imported totals only; clearly showing No level)
  const targetLangForLevel = opts.languageId === 'all' ? 'ja' : opts.languageId;
  const pack = getLanguagePack(targetLangForLevel);
  const levelCodes = pack.levelSystem.levels.map((l) => l.code);
  const supportsKanji = targetLangForLevel === 'ja';

  const levelProgressRows = await computeLevelProgress({
    languageId: targetLangForLevel,
    levelSystemLevels: pack.levelSystem.levels,
    cards: cards.filter((c) => c.languageId === targetLangForLevel),
    wordStatuses: wordStatusesRaw.filter((w) => w.languageId === targetLangForLevel),
    demoWordStatuses:
      demoMatchesFilter && demoMeta?.wordStatuses ? demoMeta.wordStatuses : [],
    supportsKanji,
  });

  const result: DashboardStats = {
    generatedAt: nowMs,
    totalMatchingLogs: periodLogCount,
    hasAnyLogs: logs.length > 0,
    hasDemoLogsIncluded,
    today: {
      reviews: todayReviews,
      newCardsLearned: todayNewCardSet.size,
      timeMs: todayTimeMs,
      accuracyPct: todayReviews > 0 ? Math.round((todayPassed / todayReviews) * 100) : null,
      dailyGoal: s.dailyGoalReviews,
    },
    streaks: {
      currentStreak,
      longestStreak,
      daysThisMonth,
      minReviewsPerDay: minRev,
      streakFreezeEnabled: freezeEnabled,
      freezesUsedThisWeek,
    },
    heatmap: {
      cells: heatmapCells,
      maxCount: maxHeatmapCount,
      totalYearReviews,
      startDateKey: heatmapStartKey,
      endDateKey: todayKey,
    },
    retention: {
      reviewStateTotal: periodRetTotal,
      reviewStatePassed: periodRetPass,
      trueRetentionPct:
        periodRetTotal >= 30
          ? Number(((periodRetPass / periodRetTotal) * 100).toFixed(1))
          : null,
      desiredRetentionPct: Math.round(s.desiredRetention * 100),
      hasEnoughData: hasEnoughRetentionData,
      series: retentionSeries,
    },
    answerBreakdown: {
      total: periodLogCount,
      ratings,
      byState: [
        toStateRow('New', stateBreakdown.new),
        toStateRow('Learning', stateBreakdown.learning),
        toStateRow('Review', stateBreakdown.review),
      ],
    },
    forecast: {
      days: forecastDays,
      dueTomorrow,
      dueThisWeek,
      totalScheduled: totalScheduledForecast,
    },
    maturity,
    intervalHistogram: intervalBuckets.map(({ label, count }) => ({ label, count })),
    wordsLearned: {
      series: wordsLearnedSeries,
      totalMature: cumMature,
      totalKnownWords: cumKnown,
    },
    studyTime: {
      daily: studyTimeDaily,
      totalMinutes: Number(totalStudyMinutes.toFixed(1)),
      avgMinutesPerActiveDay:
        activeStudyDays > 0 ? Number((totalStudyMinutes / activeStudyDays).toFixed(1)) : 0,
      avgMinutesPerPeriodDay:
        timelineKeys.length > 0
          ? Number((totalStudyMinutes / timelineKeys.length).toFixed(1))
          : 0,
      activeDays: activeStudyDays,
    },
    hardestCards,
    leechCards,
    levelProgress: {
      systemName: pack.levelSystem.name,
      supportsKanji,
      hasImportedVocab: levelProgressRows.hasImportedVocab,
      hasImportedKanji: levelProgressRows.hasImportedKanji,
      rows: levelProgressRows.rows,
    },
    lookups: {
      daily: lookupsDaily,
      topWords: topLookupRows,
      totalUniqueLookedUp,
      convertedToCardsCount,
      conversionPct,
    },
    csvDailySeries,
    allDecks: decks,
  };

  if (opts.nowMs === undefined && levelCodes.length >= 0) {
    statsCache.set(cacheKey, result);
  }

  return result;
}

const KANJI_CHAR_REGEX = /[\u4e00-\u9faf\u3400-\u4dbf]/;

async function computeLevelProgress(params: {
  languageId: string;
  levelSystemLevels: { code: string; label: string; rankOrder: number }[];
  cards: CardItem[];
  wordStatuses: { word: string; status: string }[];
  demoWordStatuses: { word: string; status: string; level?: string }[];
  supportsKanji: boolean;
}): Promise<{
  hasImportedVocab: boolean;
  hasImportedKanji: boolean;
  rows: LevelProgressRow[];
}> {
  const { languageId, levelSystemLevels, cards, wordStatuses, demoWordStatuses, supportsKanji } =
    params;

  const knownOrLearnedWords = new Set<string>();
  const cardLevelByWord = new Map<string, string>();
  const learnedKanjiChars = new Set<string>();

  for (const ws of wordStatuses) {
    if (ws.status === 'known' || ws.status === 'learning') {
      knownOrLearnedWords.add(ws.word);
      if (supportsKanji) {
        for (const ch of ws.word) {
          if (KANJI_CHAR_REGEX.test(ch)) learnedKanjiChars.add(ch);
        }
      }
    }
  }
  for (const dws of demoWordStatuses) {
    if (dws.status === 'known' || dws.status === 'learning') {
      knownOrLearnedWords.add(dws.word);
      if (dws.level) cardLevelByWord.set(dws.word, dws.level.toUpperCase());
      if (supportsKanji) {
        for (const ch of dws.word) {
          if (KANJI_CHAR_REGEX.test(ch)) learnedKanjiChars.add(ch);
        }
      }
    }
  }
  for (const c of cards) {
    if (c.suspended) continue;
    if ((c.reps ?? 0) > 0 || c.state === State.Review || c.state === State.Learning) {
      const key = c.lemma || c.word;
      if (key) {
        knownOrLearnedWords.add(key);
        if (c.level) cardLevelByWord.set(key, c.level.toUpperCase());
      }
      if (supportsKanji) {
        for (const ch of c.word) {
          if (KANJI_CHAR_REGEX.test(ch)) learnedKanjiChars.add(ch);
        }
      }
    }
  }

  // Imported vocab totals by level (indexed Dexie counts, never scans full 200k dictionary)
  const totalImportedVocab = await db.jmdictEntries
    .where('languageCode')
    .equals(languageId)
    .count();

  const vocabImportedMap = new Map<string, number>();
  let summedVocabLevels = 0;
  for (const lvl of levelSystemLevels) {
    const cnt = await db.jmdictEntries
      .where('jlptLevel')
      .equals(lvl.code)
      .filter((e) => e.languageCode === languageId)
      .count();
    vocabImportedMap.set(lvl.code, cnt);
    summedVocabLevels += cnt;
  }
  const vocabNoLevelTotal = Math.max(0, totalImportedVocab - summedVocabLevels);

  // Resolve levels for user's known/learned words using indexed *forms lookup
  const wordsArr = Array.from(knownOrLearnedWords);
  const resolvedVocabLevels = new Map<string, string>();
  if (wordsArr.length > 0 && totalImportedVocab > 0) {
    const CHUNK = 200;
    for (let i = 0; i < wordsArr.length; i += CHUNK) {
      const slice = wordsArr.slice(i, i + CHUNK);
      const matches = await db.jmdictEntries
        .where('forms')
        .anyOf(slice)
        .filter((e) => e.languageCode === languageId)
        .toArray();
      for (const m of matches) {
        const lvl = m.jlptLevel?.toUpperCase() || '';
        if (!lvl) continue;
        for (const f of m.forms || []) {
          if (knownOrLearnedWords.has(f) && !resolvedVocabLevels.has(f)) {
            resolvedVocabLevels.set(f, lvl);
          }
        }
      }
    }
  }

  const levelCodeSet = new Set(levelSystemLevels.map((l) => l.code.toUpperCase()));
  const wordsKnownPerLevel = new Map<string, number>();
  let wordsKnownNoLevel = 0;

  for (const w of wordsArr) {
    const lvl = (resolvedVocabLevels.get(w) || cardLevelByWord.get(w) || '').toUpperCase();
    if (lvl && levelCodeSet.has(lvl)) {
      wordsKnownPerLevel.set(lvl, (wordsKnownPerLevel.get(lvl) || 0) + 1);
    } else {
      wordsKnownNoLevel += 1;
    }
  }

  // Imported kanji totals by level (for Japanese)
  const kanjiImportedMap = new Map<string, number>();
  const kanjiKnownMap = new Map<string, number>();
  let kanjiNoLevelTotal = 0;
  let kanjiKnownNoLevel = 0;
  let totalImportedKanji = 0;

  if (supportsKanji) {
    const allKanjiEntries = await db.kanjiEntries.toArray();
    totalImportedKanji = allKanjiEntries.length;
    const importedKanjiSet = new Set<string>();

    for (const k of allKanjiEntries) {
      importedKanjiSet.add(k.character);
      const lvl = (k.jlptLevel || '').toUpperCase();
      const isLearned = learnedKanjiChars.has(k.character);
      if (lvl && levelCodeSet.has(lvl)) {
        kanjiImportedMap.set(lvl, (kanjiImportedMap.get(lvl) || 0) + 1);
        if (isLearned) {
          kanjiKnownMap.set(lvl, (kanjiKnownMap.get(lvl) || 0) + 1);
        }
      } else {
        kanjiNoLevelTotal += 1;
        if (isLearned) kanjiKnownNoLevel += 1;
      }
    }

    // Any learned kanji not in any imported kanji list also counts as No level
    for (const ch of learnedKanjiChars) {
      if (!importedKanjiSet.has(ch)) {
        kanjiKnownNoLevel += 1;
      }
    }
  }

  const rows: LevelProgressRow[] = levelSystemLevels.map((lvl) => ({
    code: lvl.code,
    label: lvl.label,
    isNoLevel: false,
    wordsKnownOrLearned: wordsKnownPerLevel.get(lvl.code.toUpperCase()) || 0,
    wordsImportedTotal: vocabImportedMap.get(lvl.code) || 0,
    kanjiKnownOrLearned: kanjiKnownMap.get(lvl.code.toUpperCase()) || 0,
    kanjiImportedTotal: kanjiImportedMap.get(lvl.code) || 0,
  }));

  rows.push({
    code: 'NO_LEVEL',
    label: 'No level',
    isNoLevel: true,
    wordsKnownOrLearned: wordsKnownNoLevel,
    wordsImportedTotal: vocabNoLevelTotal,
    kanjiKnownOrLearned: kanjiKnownNoLevel,
    kanjiImportedTotal: kanjiNoLevelTotal,
  });

  return {
    hasImportedVocab: totalImportedVocab > 0,
    hasImportedKanji: totalImportedKanji > 0,
    rows,
  };
}

export function buildStatsCsv(stats: DashboardStats): string {
  const headers = [
    'Date',
    'Reviews',
    'New Cards Learned',
    'Review-State Reviews',
    'Review-State Passed',
    'True Retention (%)',
    'Study Time (min)',
    'Lookups',
  ];

  const rows = stats.csvDailySeries.map((r) => [
    r.dateKey,
    String(r.reviews),
    String(r.newCards),
    String(r.reviewStateTotal),
    String(r.reviewStatePassed),
    r.retentionPct !== null ? String(r.retentionPct) : '',
    String(r.studyMinutes),
    String(r.lookups),
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}
