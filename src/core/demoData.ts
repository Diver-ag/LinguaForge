import { db, type CardItem, type ReviewLogItem } from '../db/db';
import { ensureDefaultDeck, generateEntityId } from '../db/cards';
import {
  DEMO_SYNTHETIC_META_KEY,
  getStudyDayBounds,
  getStudyDayKey,
} from './studySettings';
import { invalidateStatsCache } from './statsCache';
import { Rating, State } from './fsrsScheduler';

export interface DemoLookupEntry {
  word: string;
  reading: string;
  meaning: string;
  languageId: string;
  count: number;
  dailyCounts: Record<string, number>;
  hasCard: boolean;
}

export interface DemoWordStatusEntry {
  word: string;
  languageId: string;
  status: 'known' | 'learning';
  updatedAt: number;
  level?: string;
}

export interface DemoSyntheticMeta {
  isDemo: true;
  generatedAt: number;
  languageId: string;
  deckId: string;
  days: number;
  cardCount: number;
  logCount: number;
  cards: CardItem[];
  lookups: DemoLookupEntry[];
  wordStatuses: DemoWordStatusEntry[];
  matureDatesByCardId: Record<string, string>;
}

const DEMO_JA_VOCAB: {
  word: string;
  reading: string;
  meaning: string;
  level: string;
  pos: string;
}[] = [
  { word: '桜', reading: 'さくら', meaning: 'cherry blossom', level: 'N4', pos: 'Noun' },
  { word: '約束', reading: 'やくそく', meaning: 'promise; appointment', level: 'N3', pos: 'Noun' },
  { word: '図書館', reading: 'としょかん', meaning: 'library', level: 'N5', pos: 'Noun' },
  { word: '経験', reading: 'けいけん', meaning: 'experience', level: 'N3', pos: 'Noun' },
  { word: '静か', reading: 'しずか', meaning: 'quiet; peaceful', level: 'N5', pos: 'Na-adjective' },
  { word: '天気', reading: 'てんき', meaning: 'weather', level: 'N5', pos: 'Noun' },
  { word: '習慣', reading: 'しゅうかん', meaning: 'habit; custom', level: 'N4', pos: 'Noun' },
  { word: '準備', reading: 'じゅんび', meaning: 'preparation', level: 'N4', pos: 'Noun' },
  { word: '興味', reading: 'きょうみ', meaning: 'interest', level: 'N3', pos: 'Noun' },
  { word: '解決', reading: 'かいけつ', meaning: 'solution; resolution', level: 'N2', pos: 'Noun' },
  { word: '環境', reading: 'かんきょう', meaning: 'environment', level: 'N2', pos: 'Noun' },
  { word: '偶然', reading: 'ぐうぜん', meaning: 'by chance; coincidence', level: 'N3', pos: 'Adverb' },
  { word: '伝統', reading: 'でんとう', meaning: 'tradition', level: 'N2', pos: 'Noun' },
  { word: '抽象', reading: 'ちゅうしょう', meaning: 'abstract', level: 'N1', pos: 'Noun' },
  { word: '曖昧', reading: 'あいまい', meaning: 'vague; ambiguous', level: 'N1', pos: 'Na-adjective' },
  { word: '散歩', reading: 'さんぽ', meaning: 'stroll; walk', level: 'N5', pos: 'Noun' },
  { word: '飛行機', reading: 'ひこうき', meaning: 'airplane', level: 'N5', pos: 'Noun' },
  { word: '一生懸命', reading: 'いっしょうけんめい', meaning: 'with utmost effort', level: 'N4', pos: 'Na-adjective' },
  { word: '緊張', reading: 'きんちょう', meaning: 'tension; nervousness', level: 'N3', pos: 'Noun' },
  { word: '貢献', reading: 'こうけん', meaning: 'contribution', level: 'N1', pos: 'Noun' },
  { word: '木漏れ日', reading: 'こもれび', meaning: 'sunlight filtering through leaves', level: '', pos: 'Noun' },
  { word: '懐かしい', reading: 'なつかしい', meaning: 'nostalgic', level: 'N3', pos: 'I-adjective' },
  { word: '工夫', reading: 'くふう', meaning: 'ingenuity; scheme', level: 'N2', pos: 'Noun' },
  { word: '判断', reading: 'はんだん', meaning: 'judgment; decision', level: 'N3', pos: 'Noun' },
];

const DEMO_ES_VOCAB: {
  word: string;
  reading: string;
  meaning: string;
  level: string;
  pos: string;
}[] = [
  { word: 'madrugada', reading: 'madrugada', meaning: 'early morning hours', level: 'B1', pos: 'Noun' },
  { word: 'desarrollo', reading: 'desarrollo', meaning: 'development', level: 'B2', pos: 'Noun' },
  { word: 'biblioteca', reading: 'biblioteca', meaning: 'library', level: 'A1', pos: 'Noun' },
  { word: 'costumbre', reading: 'costumbre', meaning: 'habit; custom', level: 'A2', pos: 'Noun' },
  { word: 'imprescindible', reading: 'imprescindible', meaning: 'essential', level: 'C1', pos: 'Adjective' },
  { word: 'entorno', reading: 'entorno', meaning: 'environment; surroundings', level: 'B2', pos: 'Noun' },
  { word: 'esfuerzo', reading: 'esfuerzo', meaning: 'effort', level: 'B1', pos: 'Noun' },
  { word: 'hallazgo', reading: 'hallazgo', meaning: 'finding; discovery', level: 'C1', pos: 'Noun' },
];

function createSeededRng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export async function generateDemoHistory(params: {
  days: number;
  cardCount: number;
  languageId: string;
  deckId?: string;
  resetHour?: number;
}): Promise<{ logCount: number; cardCount: number; days: number }> {
  const days = Math.min(730, Math.max(1, Math.round(params.days || 90)));
  const cardCount = Math.min(500, Math.max(5, Math.round(params.cardCount || 60)));
  const languageId = params.languageId || 'ja';
  const resetHour = params.resetHour ?? 4;
  const defaultDeck = await ensureDefaultDeck(languageId);
  const deckId = params.deckId && params.deckId !== 'all' ? params.deckId : defaultDeck.id;

  // Clear previous demo logs first so repeated generation replaces cleanly
  await deleteAllDemoData({ silent: true });

  const nowMs = Date.now();
  const { dayStartMs: todayStartMs } = getStudyDayBounds(nowMs, resetHour);
  const rng = createSeededRng(20261116 + days * 31 + cardCount * 17);
  const vocabList = languageId === 'es' ? DEMO_ES_VOCAB : DEMO_JA_VOCAB;

  // Build synthetic demo cards (stored ONLY in demoSyntheticMeta, NEVER written to db.cards)
  const demoCards: CardItem[] = [];
  const cardFirstSeenDay = new Map<string, number>();
  const cardIsLeech = new Set<string>();
  const matureDatesByCardId: Record<string, string> = {};
  const demoWordStatuses: DemoWordStatusEntry[] = [];
  const demoLookups: DemoLookupEntry[] = [];

  for (let i = 0; i < cardCount; i++) {
    const base = vocabList[i % vocabList.length];
    const suffix = i >= vocabList.length ? ` #${Math.floor(i / vocabList.length) + 1}` : '';
    const word = `${base.word}${suffix}`;
    const cardId = `demo-card-${languageId}-${String(i + 1).padStart(3, '0')}`;

    // Stagger introduction across the period
    const introOffset = Math.min(days - 1, Math.floor((i / cardCount) * days * 0.9));
    const introDayIdx = days - 1 - introOffset; // 0 = oldest, days-1 = today
    cardFirstSeenDay.set(cardId, introDayIdx);

    const isSuspended = i % 19 === 18;
    const isLeech = i < 3 || i % 17 === 16;
    if (isLeech) cardIsLeech.add(cardId);

    const createdAt = todayStartMs - (days - 1 - introDayIdx) * 86_400_000 + 3_600_000;
    const ageDays = days - 1 - introDayIdx;

    let state: number = State.Review;
    let scheduledDays = 14;
    let stability = 18;
    let lapses = isLeech ? 8 + (i % 4) : i % 5 === 0 ? 1 : 0;

    if (i >= Math.floor(cardCount * 0.86)) {
      state = State.New;
      scheduledDays = 0;
      stability = 0;
      lapses = 0;
    } else if (i >= Math.floor(cardCount * 0.72)) {
      state = State.Learning;
      scheduledDays = 0;
      stability = 0.6;
    } else if (ageDays >= 28 && !isLeech && i % 3 !== 0) {
      state = State.Review;
      scheduledDays = 21 + Math.round(rng() * 95);
      stability = scheduledDays * (0.9 + rng() * 0.35);
    } else {
      state = State.Review;
      scheduledDays = 2 + Math.round(rng() * 17);
      stability = scheduledDays * 0.95;
    }

    // Spread due dates nicely over today..next 30 days
    const dueOffsetDays =
      state === State.New
        ? 0
        : state === State.Learning
        ? 0
        : (i * 3) % 29;
    const due = todayStartMs + dueOffsetDays * 86_400_000 + Math.round(rng() * 12) * 3_600_000;

    const tags = ['demo'];
    if (isLeech) tags.push('leech');

    demoCards.push({
      id: cardId,
      deckId,
      languageId,
      cardType: i % 5 === 4 ? 'reading' : 'word_to_meaning',
      word,
      lemma: base.word,
      reading: base.reading,
      meaning: base.meaning,
      partOfSpeech: base.pos,
      level: base.level,
      frequencyBand: i % 3 === 0 ? 'Common' : 'Core',
      sentence: '',
      sourceDocTitle: 'Demo Reader Corpus',
      tags,
      notes: 'Synthetic demo card preview (never modifies real cards).',
      createdAt,
      updatedAt: nowMs,
      suspended: isSuspended,
      buried: false,
      due,
      stability: Number(stability.toFixed(2)),
      difficulty: Number((4.5 + rng() * 4.2).toFixed(2)),
      reps: state === State.New ? 0 : Math.max(2, Math.round(ageDays / 4)),
      lapses,
      state,
      lastReview: state === State.New ? undefined : todayStartMs - Math.round(rng() * 5) * 86_400_000,
      scheduledDays,
      elapsedDays: state === State.New ? 0 : 1 + Math.round(rng() * 10),
      learningSteps: 0,
    });
  }

  // Generate realistic review logs over the chosen number of days
  const reviewLogs: ReviewLogItem[] = [];
  const lookupDailyMap = new Map<string, Record<string, number>>();
  const activeReviewCards = demoCards.filter((c) => c.state !== State.New);

  for (let dOffset = days - 1; dOffset >= 0; dOffset--) {
    const dayIdx = days - 1 - dOffset; // 0 .. days-1
    const dayBaseMs = todayStartMs - dOffset * 86_400_000;
    const isToday = dOffset === 0;

    // Leave ~8% occasional rest days in the past (keep recent 14 days consistent for streak showcase)
    const isRestDay = !isToday && dOffset > 14 && rng() < 0.08;
    if (isRestDay) continue;

    // Daily volume ~ 18 to 44 reviews (today ~ 24 so daily goal ring shows 24/30)
    const targetCount = isToday
      ? 24
      : Math.max(8, Math.round(22 + Math.sin(dayIdx / 5) * 8 + rng() * 16));

    const eligible = activeReviewCards.filter((c) => (cardFirstSeenDay.get(c.id) ?? 0) <= dayIdx);
    const pool = eligible.length > 0 ? eligible : activeReviewCards.slice(0, Math.min(8, activeReviewCards.length));

    for (let k = 0; k < targetCount; k++) {
      const card = pool[(dayIdx * 7 + k * 3 + Math.floor(rng() * pool.length)) % pool.length];
      const firstDay = cardFirstSeenDay.get(card.id) ?? dayIdx;
      const daysSinceIntro = Math.max(0, dayIdx - firstDay);

      let previousState: number = State.Review;
      if (daysSinceIntro === 0 && k % 3 === 0) {
        previousState = State.New;
      } else if (daysSinceIntro <= 1 || rng() < 0.16) {
        previousState = rng() < 0.75 ? State.Learning : State.Relearning;
      }

      // Rating distribution (~9% Again, ~14% Hard, ~59% Good, ~18% Easy -> ~91% true retention)
      const roll = rng();
      const leechBoost = cardIsLeech.has(card.id) ? 0.15 : 0;
      let rating: number = Rating.Good;
      if (roll < 0.085 + leechBoost) rating = Rating.Again;
      else if (roll < 0.225 + leechBoost) rating = Rating.Hard;
      else if (roll < 0.82) rating = Rating.Good;
      else rating = Rating.Easy;

      let nextState: number = State.Review;
      let scheduledDays = 1;
      if (rating === Rating.Again) {
        nextState = previousState === State.New ? State.Learning : State.Relearning;
        scheduledDays = 0;
      } else if (previousState === State.New) {
        nextState = rating === Rating.Easy ? State.Review : State.Learning;
        scheduledDays = rating === Rating.Easy ? 4 : 0;
      } else if (previousState === State.Learning || previousState === State.Relearning) {
        nextState = rating === Rating.Hard && rng() < 0.5 ? State.Learning : State.Review;
        scheduledDays = rating === Rating.Easy ? 6 : 1;
      } else {
        nextState = State.Review;
        const baseInterval = Math.max(1, Math.min(90, Math.round(2 + daysSinceIntro * 0.45)));
        scheduledDays =
          rating === Rating.Hard
            ? Math.max(1, Math.round(baseInterval * 0.75))
            : rating === Rating.Easy
            ? Math.min(180, Math.round(baseInterval * 1.45))
            : baseInterval;
      }

      // Realistic response time (1.5s to 22s, with rare >60s idle spike to verify 60s cap)
      const elapsed =
        k === 0 && dayIdx % 11 === 0
          ? 125_000
          : Math.round(1800 + rng() * 14_000);

      const reviewedAt = Math.min(
        nowMs - 5_000,
        dayBaseMs + 1_800_000 + Math.round(((k + rng()) / Math.max(1, targetCount)) * 43_200_000)
      );

      reviewLogs.push({
        id: generateEntityId('demolog'),
        cardId: card.id,
        deckId,
        languageId,
        rating,
        reviewedAt,
        elapsed,
        previousState,
        state: nextState,
        scheduledDays,
        previousDue: dayBaseMs,
        newDue: dayBaseMs + Math.max(1, scheduledDays) * 86_400_000,
        isCustomStudy: false,
        isDemo: true,
      });

      if (nextState === State.Review && scheduledDays >= 21 && !matureDatesByCardId[card.id]) {
        matureDatesByCardId[card.id] = getStudyDayKey(reviewedAt, resetHour);
      }
    }

    // Synthetic lookups on most days
    if (dOffset < Math.min(days, 90) && rng() < 0.8) {
      const dayKey = getStudyDayKey(dayBaseMs + 7_200_000, resetHour);
      const lookupsToday = 2 + Math.floor(rng() * 6);
      for (let l = 0; l < lookupsToday; l++) {
        const vocab = vocabList[(dayIdx + l * 5) % vocabList.length];
        const perDay = lookupDailyMap.get(vocab.word) || {};
        perDay[dayKey] = (perDay[dayKey] || 0) + 1;
        lookupDailyMap.set(vocab.word, perDay);
      }
    }
  }

  // Ensure every card marked mature has a mature date
  for (const c of demoCards) {
    if (c.state === State.Review && (c.scheduledDays ?? 0) >= 21 && !matureDatesByCardId[c.id]) {
      const fallbackDay = Math.max(0, days - 7);
      const ts = todayStartMs - fallbackDay * 86_400_000 + 7_200_000;
      matureDatesByCardId[c.id] = getStudyDayKey(ts, resetHour);
    }
  }

  // Synthetic known word statuses
  vocabList.forEach((v, idx) => {
    const dayAgo = Math.min(days - 1, Math.max(1, Math.round((idx / vocabList.length) * days)));
    demoWordStatuses.push({
      word: v.word,
      languageId,
      status: idx < Math.ceil(vocabList.length * 0.65) ? 'known' : 'learning',
      updatedAt: todayStartMs - dayAgo * 86_400_000 + 10_000_000,
      level: v.level,
    });

    const dailyCounts = lookupDailyMap.get(v.word) || {};
    const totalCount = Object.values(dailyCounts).reduce((a, b) => a + b, 0) || (idx % 4) + 1;
    demoLookups.push({
      word: v.word,
      reading: v.reading,
      meaning: v.meaning,
      languageId,
      count: totalCount,
      dailyCounts,
      hasCard: idx < Math.ceil(vocabList.length * 0.6),
    });
  });

  // Bulk insert synthetic reviewLogs in chunks
  const BATCH = 1000;
  for (let i = 0; i < reviewLogs.length; i += BATCH) {
    await db.reviewLogs.bulkPut(reviewLogs.slice(i, i + BATCH));
  }

  const meta: DemoSyntheticMeta = {
    isDemo: true,
    generatedAt: nowMs,
    languageId,
    deckId,
    days,
    cardCount: demoCards.length,
    logCount: reviewLogs.length,
    cards: demoCards,
    lookups: demoLookups,
    wordStatuses: demoWordStatuses,
    matureDatesByCardId,
  };

  await db.settings.put({ key: DEMO_SYNTHETIC_META_KEY, value: meta });
  invalidateStatsCache();

  return {
    logCount: reviewLogs.length,
    cardCount: demoCards.length,
    days,
  };
}

export async function deleteAllDemoData(opts?: { silent?: boolean }): Promise<number> {
  const demoLogs = await db.reviewLogs.filter((l) => Boolean(l.isDemo)).primaryKeys();
  if (demoLogs.length > 0) {
    await db.reviewLogs.bulkDelete(demoLogs);
  }
  await db.settings.delete(DEMO_SYNTHETIC_META_KEY);
  if (!opts?.silent) {
    invalidateStatsCache();
  }
  return demoLogs.length;
}

export async function getDemoDataStatus(): Promise<{
  hasDemoData: boolean;
  logCount: number;
  cardCount: number;
  days: number;
  generatedAt?: number;
}> {
  const metaItem = await db.settings.get(DEMO_SYNTHETIC_META_KEY);
  const meta = metaItem?.value as DemoSyntheticMeta | undefined;
  const logCount = await db.reviewLogs.filter((l) => Boolean(l.isDemo)).count();
  return {
    hasDemoData: logCount > 0 || Boolean(meta),
    logCount,
    cardCount: meta?.cardCount || 0,
    days: meta?.days || 0,
    generatedAt: meta?.generatedAt,
  };
}
