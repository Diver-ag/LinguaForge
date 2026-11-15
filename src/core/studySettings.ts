import { db, type DeckItem } from '../db/db';
import { logEvent } from './eventLogger';

export type NewCardOrder = 'added' | 'random';
export type NewCardMix = 'first' | 'mixed' | 'after';

export interface DeckStudySettings {
  newCardsPerDay?: number;
  maxReviewsPerDay?: number;
  newCardOrder?: NewCardOrder;
}

export interface StudySettings {
  newCardsPerDay: number;
  maxReviewsPerDay: number;
  newCardOrder: NewCardOrder;
  newCardMix: NewCardMix;
  dayResetHour: number; // 0-23 local hour (default 4 -> 4:00 AM)
  desiredRetention: number; // 0.70 - 0.97 (default 0.90)
  maximumInterval: number; // max days (default 36500)
  enableFuzz: boolean; // default true
  leechThreshold: number; // default 8 lapses
}

export const DEFAULT_STUDY_SETTINGS: StudySettings = {
  newCardsPerDay: 20,
  maxReviewsPerDay: 200,
  newCardOrder: 'added',
  newCardMix: 'mixed',
  dayResetHour: 4,
  desiredRetention: 0.9,
  maximumInterval: 36500,
  enableFuzz: true,
  leechThreshold: 8,
};

export const STUDY_SETTINGS_KEY = 'studySettings';

export function normalizeStudySettings(raw?: Partial<StudySettings> | null): StudySettings {
  const s = raw || {};
  const clampNum = (val: unknown, fallback: number, min: number, max: number) => {
    const n = typeof val === 'number' && Number.isFinite(val) ? val : fallback;
    return Math.min(max, Math.max(min, n));
  };

  return {
    newCardsPerDay: Math.round(clampNum(s.newCardsPerDay, DEFAULT_STUDY_SETTINGS.newCardsPerDay, 0, 9999)),
    maxReviewsPerDay: Math.round(clampNum(s.maxReviewsPerDay, DEFAULT_STUDY_SETTINGS.maxReviewsPerDay, 0, 99999)),
    newCardOrder: s.newCardOrder === 'random' ? 'random' : 'added',
    newCardMix: s.newCardMix === 'first' || s.newCardMix === 'after' ? s.newCardMix : 'mixed',
    dayResetHour: Math.round(clampNum(s.dayResetHour, DEFAULT_STUDY_SETTINGS.dayResetHour, 0, 23)),
    desiredRetention: Number(clampNum(s.desiredRetention, DEFAULT_STUDY_SETTINGS.desiredRetention, 0.7, 0.97).toFixed(2)),
    maximumInterval: Math.round(clampNum(s.maximumInterval, DEFAULT_STUDY_SETTINGS.maximumInterval, 1, 36500)),
    enableFuzz: s.enableFuzz !== undefined ? Boolean(s.enableFuzz) : DEFAULT_STUDY_SETTINGS.enableFuzz,
    leechThreshold: Math.round(clampNum(s.leechThreshold, DEFAULT_STUDY_SETTINGS.leechThreshold, 1, 100)),
  };
}

export async function getStudySettings(): Promise<StudySettings> {
  try {
    const item = await db.settings.get(STUDY_SETTINGS_KEY);
    return normalizeStudySettings(item?.value);
  } catch {
    return { ...DEFAULT_STUDY_SETTINGS };
  }
}

export async function saveStudySettings(patch: Partial<StudySettings>): Promise<StudySettings> {
  const current = await getStudySettings();
  const next = normalizeStudySettings({ ...current, ...patch });
  await db.settings.put({ key: STUDY_SETTINGS_KEY, value: next });
  await logEvent('study_settings_updated', next);
  return next;
}

export function getEffectiveDeckLimits(
  deck: DeckItem | undefined,
  globalSettings: StudySettings
): {
  newCardsPerDay: number;
  maxReviewsPerDay: number;
  newCardOrder: NewCardOrder;
  hasOverrides: boolean;
} {
  const ds = deck?.studySettings;
  const newCardsPerDay =
    typeof ds?.newCardsPerDay === 'number' && Number.isFinite(ds.newCardsPerDay)
      ? Math.max(0, Math.round(ds.newCardsPerDay))
      : globalSettings.newCardsPerDay;
  const maxReviewsPerDay =
    typeof ds?.maxReviewsPerDay === 'number' && Number.isFinite(ds.maxReviewsPerDay)
      ? Math.max(0, Math.round(ds.maxReviewsPerDay))
      : globalSettings.maxReviewsPerDay;
  const newCardOrder: NewCardOrder =
    ds?.newCardOrder === 'random' || ds?.newCardOrder === 'added'
      ? ds.newCardOrder
      : globalSettings.newCardOrder;

  const hasOverrides = Boolean(
    ds &&
      (ds.newCardsPerDay !== undefined ||
        ds.maxReviewsPerDay !== undefined ||
        ds.newCardOrder !== undefined)
  );

  return {
    newCardsPerDay,
    maxReviewsPerDay,
    newCardOrder,
    hasOverrides,
  };
}

export async function saveDeckStudySettings(
  deckId: string,
  studySettings: DeckStudySettings | undefined
): Promise<void> {
  const clean: DeckStudySettings | undefined = studySettings
    ? {
        ...(studySettings.newCardsPerDay !== undefined
          ? { newCardsPerDay: Math.max(0, Math.round(studySettings.newCardsPerDay)) }
          : {}),
        ...(studySettings.maxReviewsPerDay !== undefined
          ? { maxReviewsPerDay: Math.max(0, Math.round(studySettings.maxReviewsPerDay)) }
          : {}),
        ...(studySettings.newCardOrder !== undefined
          ? { newCardOrder: studySettings.newCardOrder }
          : {}),
      }
    : undefined;

  const isEmpty = !clean || Object.keys(clean).length === 0;
  await db.decks.update(deckId, {
    studySettings: isEmpty ? undefined : clean,
  });
  await logEvent('deck_study_settings_updated', { deckId, hasOverrides: !isEmpty });
}

/**
 * Computes the local study day start and next reset boundary for a given timestamp and reset hour.
 * If local time is 2:00 AM and resetHour is 4, the study day started yesterday at 4:00 AM.
 */
export function getStudyDayBounds(
  nowMs: number = Date.now(),
  resetHour: number = 4
): { dayStartMs: number; nextDayStartMs: number } {
  const safeResetHour = Math.min(23, Math.max(0, Math.round(resetHour)));
  const d = new Date(nowMs);
  const todayReset = new Date(d.getFullYear(), d.getMonth(), d.getDate(), safeResetHour, 0, 0, 0);

  if (nowMs < todayReset.getTime()) {
    const yesterdayReset = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() - 1,
      safeResetHour,
      0,
      0,
      0
    );
    return {
      dayStartMs: yesterdayReset.getTime(),
      nextDayStartMs: todayReset.getTime(),
    };
  }

  const tomorrowReset = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + 1,
    safeResetHour,
    0,
    0,
    0
  );
  return {
    dayStartMs: todayReset.getTime(),
    nextDayStartMs: tomorrowReset.getTime(),
  };
}
