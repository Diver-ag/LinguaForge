import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, type CardItem, type DeckItem } from '../../db/db';
import { useAppStore } from '../../store/useAppStore';
import { getAllLanguagePacks, getLanguagePack } from '../../packs/registry';
import {
  DEFAULT_STUDY_SETTINGS,
  getDeveloperSettings,
  getStudySettings,
  saveDeveloperSettings,
  type StudySettings,
} from '../../core/studySettings';
import {
  buildStatsCsv,
  computeDashboardStats,
  type DashboardStats,
  type StatsPeriod,
} from '../../core/statsEngine';
import { DailyGoalRing } from '../../components/DailyGoalRing';
import { CardEditModal } from '../cards/CardEditModal';
import {
  CalendarHeatmapSvg,
  DailyMetricBarChartSvg,
  ForecastBarChartSvg,
  IntervalHistogramSvg,
  MaturityDonutSvg,
  RetentionLineChartSvg,
  WordsLearnedChartSvg,
} from './StatsCharts';
import {
  BarChart3,
  Download,
  RefreshCw,
  AlertCircle,
  Loader2,
  Flame,
  Calendar,
  Target,
  Clock,
  Layers,
  BookOpen,
  AlertTriangle,
  Search,
  GraduationCap,
} from 'lucide-react';

interface StatsCardProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  emptyMessage?: string;
  onRetry?: () => void;
  className?: string;
  children: React.ReactNode;
}

const StatsCard: React.FC<StatsCardProps> = ({
  title,
  subtitle,
  action,
  loading,
  error,
  isEmpty,
  emptyMessage = 'Study some cards to see this',
  onRetry,
  className = '',
  children,
}) => {
  return (
    <section
      className={`p-5 rounded-3xl bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-4 ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-[var(--text)]">{title}</h2>
          {subtitle && (
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5 leading-relaxed">
              {subtitle}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      {loading ? (
        <div className="py-10 flex items-center justify-center gap-2 text-xs text-[var(--text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin text-indigo-600 dark:text-indigo-400" />
          <span>Calculating statistics...</span>
        </div>
      ) : error ? (
        <div className="py-8 px-4 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-center space-y-2">
          <AlertCircle className="w-6 h-6 text-rose-600 dark:text-rose-400 mx-auto" />
          <p className="text-xs text-rose-700 dark:text-rose-300 font-medium">{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold"
            >
              Retry
            </button>
          )}
        </div>
      ) : isEmpty ? (
        <div className="py-10 px-4 rounded-2xl bg-[var(--surface-muted)]/60 border border-dashed border-[var(--border)] text-center space-y-1.5">
          <BarChart3 className="w-6 h-6 text-[var(--text-muted)] mx-auto opacity-70" />
          <p className="text-xs font-medium text-[var(--text-muted)]">{emptyMessage}</p>
        </div>
      ) : (
        children
      )}
    </section>
  );
};

function formatDurationMinutes(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs === 0) return `${mins}m`;
  return `${hrs}h ${mins % 60}m`;
}

export const StatsView: React.FC = () => {
  const navigate = useNavigate();
  const { activeLanguageId } = useAppStore();
  const allPacks = getAllLanguagePacks();

  const [languageFilter, setLanguageFilter] = useState<string>(activeLanguageId);
  const [deckFilter, setDeckFilter] = useState<string>('all');
  const [period, setPeriod] = useState<StatsPeriod>('30d');
  const [includeDemoData, setIncludeDemoData] = useState<boolean>(false);
  const [studySettings, setStudySettings] = useState<StudySettings>(DEFAULT_STUDY_SETTINGS);

  const [decksForSelect, setDecksForSelect] = useState<DeckItem[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [forecastCumulative, setForecastCumulative] = useState<boolean>(false);
  const [editingCard, setEditingCard] = useState<CardItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Sync default language filter when user switches global language
  useEffect(() => {
    setLanguageFilter(activeLanguageId);
    setDeckFilter('all');
  }, [activeLanguageId]);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, devSettings, deckList] = await Promise.all([
        getStudySettings(),
        getDeveloperSettings(),
        languageFilter === 'all'
          ? db.decks.toArray()
          : db.decks.where('languageId').equals(languageFilter).toArray(),
      ]);

      setStudySettings(settings);
      setIncludeDemoData(devSettings.includeDemoData);
      setDecksForSelect(deckList);

      const effectiveDeckId =
        deckFilter !== 'all' && deckList.some((d) => d.id === deckFilter)
          ? deckFilter
          : 'all';
      if (effectiveDeckId !== deckFilter) {
        setDeckFilter('all');
      }

      const computed = await computeDashboardStats({
        languageId: languageFilter,
        deckId: effectiveDeckId,
        period,
        includeDemoData: devSettings.includeDemoData,
        studySettings: settings,
      });

      setStats(computed);
    } catch (err: any) {
      setError(err?.message || 'Failed to compute statistics.');
    } finally {
      setLoading(false);
    }
  }, [languageFilter, deckFilter, period]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const handleDisableDemoView = async () => {
    await saveDeveloperSettings({ includeDemoData: false });
    await loadStats();
  };

  const handleExportCsv = () => {
    if (!stats) return;
    const csv = buildStatsCsv(stats);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `linguaforge-stats-${languageFilter}-${period}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const periods: { id: StatsPeriod; label: string }[] = [
    { id: '7d', label: '7 days' },
    { id: '30d', label: '30 days' },
    { id: '90d', label: '90 days' },
    { id: '1y', label: '1 year' },
    { id: 'all', label: 'All time' },
  ];

  const activePack = getLanguagePack(languageFilter === 'all' ? activeLanguageId : languageFilter);

  const studyTimePoints = useMemo(
    () =>
      (stats?.studyTime.daily || []).map((d) => ({
        dateKey: d.dateKey,
        label: d.label,
        value: d.minutes,
      })),
    [stats]
  );

  const lookupDailyPoints = useMemo(
    () =>
      (stats?.lookups.daily || []).map((d) => ({
        dateKey: d.dateKey,
        label: d.label,
        value: d.count,
      })),
    [stats]
  );

  const ratingColors: Record<number, { text: string; bar: string }> = {
    1: { text: 'text-rose-600 dark:text-rose-400', bar: '#e11d48' },
    2: { text: 'text-amber-600 dark:text-amber-400', bar: '#d97706' },
    3: { text: 'text-emerald-600 dark:text-emerald-400', bar: '#10b981' },
    4: { text: 'text-sky-600 dark:text-sky-400', bar: '#0ea5e9' },
  };

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text)] flex flex-col pb-24 md:pb-12">
      {/* Header & Controls */}
      <header className="bg-[var(--surface)] border-b border-[var(--border)] px-4 py-5">
        <div className="max-w-6xl mx-auto space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <BarChart3 className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                <h1 className="text-2xl font-black tracking-tight">Study Statistics</h1>
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Read-only analytics across reviews, FSRS intervals, vocabulary levels, and lookups
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleExportCsv}
                disabled={!stats || loading}
                className="min-h-[40px] px-3.5 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] disabled:opacity-50 text-xs font-semibold text-[var(--text)] inline-flex items-center gap-1.5 transition whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export stats as CSV</span>
              </button>
              <button
                type="button"
                onClick={loadStats}
                disabled={loading}
                aria-label="Refresh statistics"
                className="min-h-[40px] px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] disabled:opacity-50 text-xs font-semibold text-[var(--text-secondary)] inline-flex items-center gap-1.5 transition whitespace-nowrap"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
            </div>
          </div>

          {/* Filters Row */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={languageFilter}
                onChange={(e) => {
                  setLanguageFilter(e.target.value);
                  setDeckFilter('all');
                }}
                aria-label="Filter by language"
                className="min-h-[38px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-xs font-semibold text-[var(--text)]"
              >
                <option value="all">All languages</option>
                {allPacks.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.flagEmoji} {p.name}
                  </option>
                ))}
              </select>

              <select
                value={deckFilter}
                onChange={(e) => setDeckFilter(e.target.value)}
                aria-label="Filter by deck"
                className="min-h-[38px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-xs font-semibold text-[var(--text)]"
              >
                <option value="all">All decks</option>
                {decksForSelect.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Period Segmented Filter */}
            <div
              className="inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-[var(--surface-muted)] border border-[var(--border)]"
              role="group"
              aria-label="Time period filter"
            >
              {periods.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPeriod(p.id)}
                  className={`min-h-[32px] px-3 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                    period === p.id
                      ? 'bg-[var(--surface)] text-[var(--accent-text)] shadow-xs'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text)]'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl w-full mx-auto p-4 sm:p-6 space-y-6 flex-1">
        {/* Active Demo Mode Notice */}
        {includeDemoData && (
          <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-semibold">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                Demo data is currently included in statistics (real card schedules remain untouched).
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleDisableDemoView}
                className="px-3 py-1.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] font-semibold text-[var(--text)] hover:bg-[var(--surface-muted)]"
              >
                Exclude demo data
              </button>
              <button
                type="button"
                onClick={() => navigate('/settings')}
                className="px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-semibold"
              >
                Developer tools
              </button>
            </div>
          </div>
        )}

        {notice && (
          <div className="p-3 rounded-2xl bg-[var(--accent-subtle)] border border-indigo-500/30 flex items-center justify-between text-xs text-[var(--accent-text)] font-semibold">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="underline">
              Dismiss
            </button>
          </div>
        )}

        {/* Row 1: Today + Streaks */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 2a) Today */}
          <StatsCard
            title="Today"
            subtitle={`Resets daily at ${new Date(2026, 0, 1, studySettings.dayResetHour, 0).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} local time`}
            loading={loading}
            error={error}
            isEmpty={!stats || (!stats.hasAnyLogs && stats.today.reviews === 0)}
            onRetry={loadStats}
          >
            {stats && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
                <DailyGoalRing
                  reviewed={stats.today.reviews}
                  goal={stats.today.dailyGoal}
                />

                <div className="grid grid-cols-2 sm:grid-cols-2 gap-3 flex-1 tabular-nums">
                  <div className="p-3 rounded-2xl bg-[var(--surface-muted)]/70">
                    <div className="text-[11px] text-[var(--text-muted)]">Cards reviewed</div>
                    <div className="text-lg font-black text-[var(--text)] mt-0.5">
                      {stats.today.reviews}
                    </div>
                  </div>
                  <div className="p-3 rounded-2xl bg-[var(--surface-muted)]/70">
                    <div className="text-[11px] text-[var(--text-muted)]">New learned</div>
                    <div className="text-lg font-black text-sky-600 dark:text-sky-400 mt-0.5">
                      {stats.today.newCardsLearned}
                    </div>
                  </div>
                  <div className="p-3 rounded-2xl bg-[var(--surface-muted)]/70">
                    <div className="text-[11px] text-[var(--text-muted)]">Time spent</div>
                    <div className="text-lg font-black text-[var(--text)] mt-0.5">
                      {formatDurationMinutes(stats.today.timeMs)}
                    </div>
                  </div>
                  <div className="p-3 rounded-2xl bg-[var(--surface-muted)]/70">
                    <div className="text-[11px] text-[var(--text-muted)]">Accuracy</div>
                    <div className="text-lg font-black text-emerald-600 dark:text-emerald-400 mt-0.5">
                      {stats.today.accuracyPct !== null ? `${stats.today.accuracyPct}%` : '—'}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </StatsCard>

          {/* 2b) Streaks */}
          <StatsCard
            title="Streaks"
            subtitle={`Day counts with ≥ ${stats?.streaks.minReviewsPerDay ?? studySettings.streakMinReviews} review${(stats?.streaks.minReviewsPerDay ?? 1) === 1 ? '' : 's'} · ${studySettings.streakFreezeEnabled ? 'Streak freeze ON (1/wk)' : 'Streak freeze OFF'}`}
            action={<Flame className="w-4 h-4 text-amber-500" />}
            loading={loading}
            error={error}
            isEmpty={!stats || !stats.hasAnyLogs}
            onRetry={loadStats}
          >
            {stats && (
              <div className="grid grid-cols-3 gap-3 tabular-nums">
                <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)]/70 space-y-1">
                  <div className="text-[11px] text-[var(--text-muted)]">Current streak</div>
                  <div className="text-2xl font-black text-amber-600 dark:text-amber-400">
                    {stats.streaks.currentStreak}
                    <span className="text-xs font-semibold text-[var(--text-muted)] ml-1">d</span>
                  </div>
                </div>
                <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)]/70 space-y-1">
                  <div className="text-[11px] text-[var(--text-muted)]">Longest streak</div>
                  <div className="text-2xl font-black text-[var(--text)]">
                    {stats.streaks.longestStreak}
                    <span className="text-xs font-semibold text-[var(--text-muted)] ml-1">d</span>
                  </div>
                </div>
                <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)]/70 space-y-1">
                  <div className="text-[11px] text-[var(--text-muted)]">This month</div>
                  <div className="text-2xl font-black text-indigo-600 dark:text-indigo-400">
                    {stats.streaks.daysThisMonth}
                    <span className="text-xs font-semibold text-[var(--text-muted)] ml-1">d</span>
                  </div>
                </div>
              </div>
            )}
          </StatsCard>
        </div>

        {/* 2c) Review Heatmap */}
        <StatsCard
          title="Review Heatmap (Last 12 Months)"
          subtitle={
            stats
              ? `${stats.heatmap.totalYearReviews.toLocaleString()} reviews from ${stats.heatmap.startDateKey} to ${stats.heatmap.endDateKey}`
              : undefined
          }
          action={<Calendar className="w-4 h-4 text-[var(--text-muted)]" />}
          loading={loading}
          error={error}
          isEmpty={!stats || !stats.hasAnyLogs}
          onRetry={loadStats}
        >
          {stats && <CalendarHeatmapSvg cells={stats.heatmap.cells} />}
        </StatsCard>

        {/* Row 3: True Retention + Answer Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 2d) Retention */}
          <StatsCard
            title="True Retention"
            subtitle="Review-state cards answered Hard / Good / Easy vs Again"
            action={
              stats && stats.retention.hasEnoughData && stats.retention.trueRetentionPct !== null ? (
                <div className="text-right tabular-nums">
                  <div className="text-lg font-black text-emerald-600 dark:text-emerald-400 leading-none">
                    {stats.retention.trueRetentionPct}%
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                    Target {stats.retention.desiredRetentionPct}%
                  </div>
                </div>
              ) : (
                <Target className="w-4 h-4 text-[var(--text-muted)]" />
              )
            }
            loading={loading}
            error={error}
            isEmpty={!stats || stats.totalMatchingLogs === 0}
            onRetry={loadStats}
          >
            {stats &&
              (!stats.retention.hasEnoughData ? (
                <div className="py-8 px-4 rounded-2xl bg-[var(--surface-muted)]/60 border border-dashed border-[var(--border)] text-center space-y-1.5">
                  <Target className="w-6 h-6 text-[var(--text-muted)] mx-auto" />
                  <p className="text-xs font-semibold text-[var(--text)]">
                    Too little review data for true retention yet
                  </p>
                  <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
                    {stats.retention.reviewStateTotal} / 30 review-state answers recorded in this period (desired target: {stats.retention.desiredRetentionPct}%).
                  </p>
                </div>
              ) : (
                <RetentionLineChartSvg
                  series={stats.retention.series}
                  desiredPct={stats.retention.desiredRetentionPct}
                />
              ))}
          </StatsCard>

          {/* 2e) Answer Breakdown */}
          <StatsCard
            title="Answer Breakdown"
            subtitle={
              stats ? `${stats.answerBreakdown.total.toLocaleString()} total answers in period` : undefined
            }
            loading={loading}
            error={error}
            isEmpty={!stats || stats.answerBreakdown.total === 0}
            onRetry={loadStats}
          >
            {stats && (
              <div className="space-y-4">
                {/* Rating distribution bar */}
                <div className="h-3 w-full rounded-full overflow-hidden flex bg-[var(--surface-muted)]">
                  {stats.answerBreakdown.ratings.map((r) =>
                    r.pct > 0 ? (
                      <div
                        key={r.rating}
                        style={{
                          width: `${r.pct}%`,
                          backgroundColor: ratingColors[r.rating].bar,
                        }}
                        title={`${r.label}: ${r.count} (${r.pct}%)`}
                      />
                    ) : null
                  )}
                </div>

                {/* Rating counts */}
                <div className="grid grid-cols-4 gap-2 text-center tabular-nums">
                  {stats.answerBreakdown.ratings.map((r) => (
                    <div
                      key={r.rating}
                      className="p-2.5 rounded-2xl bg-[var(--surface-muted)]/70"
                    >
                      <div className={`text-xs font-bold ${ratingColors[r.rating].text}`}>
                        {r.label}
                      </div>
                      <div className="text-base font-black text-[var(--text)] mt-0.5">
                        {r.count}
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)]">{r.pct}%</div>
                    </div>
                  ))}
                </div>

                {/* Split by card state */}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs tabular-nums">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-[var(--text-muted)] text-left">
                        <th className="py-1.5 font-semibold">State</th>
                        <th className="py-1.5 font-semibold text-right">Again</th>
                        <th className="py-1.5 font-semibold text-right">Hard</th>
                        <th className="py-1.5 font-semibold text-right">Good</th>
                        <th className="py-1.5 font-semibold text-right">Easy</th>
                        <th className="py-1.5 font-semibold text-right">Pass %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.answerBreakdown.byState.map((row) => (
                        <tr key={row.stateLabel} className="border-b border-[var(--border-subtle)] last:border-0">
                          <td className="py-2 font-semibold text-[var(--text)]">{row.stateLabel}</td>
                          <td className="py-2 text-right text-rose-600 dark:text-rose-400">{row.again}</td>
                          <td className="py-2 text-right text-amber-600 dark:text-amber-400">{row.hard}</td>
                          <td className="py-2 text-right text-emerald-600 dark:text-emerald-400">{row.good}</td>
                          <td className="py-2 text-right text-sky-600 dark:text-sky-400">{row.easy}</td>
                          <td className="py-2 text-right font-bold text-[var(--text)]">
                            {row.passPct !== null ? `${row.passPct}%` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </StatsCard>
        </div>

        {/* Row 4: 30-Day Forecast + Card Maturity / Interval Histogram */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 2f) Forecast */}
          <StatsCard
            title="Due Forecast (Next 30 Days)"
            subtitle={
              stats
                ? `Due tomorrow: ${stats.forecast.dueTomorrow} · Due this week: ${stats.forecast.dueThisWeek}`
                : undefined
            }
            action={
              <div className="inline-flex rounded-xl bg-[var(--surface-muted)] p-0.5 border border-[var(--border)] text-[11px] font-semibold">
                <button
                  type="button"
                  onClick={() => setForecastCumulative(false)}
                  className={`px-2.5 py-1 rounded-lg transition ${
                    !forecastCumulative
                      ? 'bg-[var(--surface)] text-[var(--accent-text)] shadow-xs'
                      : 'text-[var(--text-muted)]'
                  }`}
                >
                  Daily
                </button>
                <button
                  type="button"
                  onClick={() => setForecastCumulative(true)}
                  className={`px-2.5 py-1 rounded-lg transition ${
                    forecastCumulative
                      ? 'bg-[var(--surface)] text-[var(--accent-text)] shadow-xs'
                      : 'text-[var(--text-muted)]'
                  }`}
                >
                  Cumulative
                </button>
              </div>
            }
            loading={loading}
            error={error}
            isEmpty={!stats || stats.forecast.totalScheduled === 0}
            onRetry={loadStats}
          >
            {stats && (
              <ForecastBarChartSvg
                days={stats.forecast.days}
                cumulative={forecastCumulative}
              />
            )}
          </StatsCard>

          {/* 2g) Card Maturity & Interval Distribution */}
          <StatsCard
            title="Card Maturity & Intervals"
            subtitle="Young (<21 days) vs Mature (21+ days) across active cards"
            action={<Layers className="w-4 h-4 text-[var(--text-muted)]" />}
            loading={loading}
            error={error}
            isEmpty={!stats || stats.maturity.totalCards === 0}
            onRetry={loadStats}
          >
            {stats && (
              <div className="space-y-5">
                <MaturityDonutSvg maturity={stats.maturity} />
                <div className="pt-3 border-t border-[var(--border)] space-y-2">
                  <div className="text-xs font-semibold text-[var(--text-secondary)]">
                    Interval Distribution
                  </div>
                  <IntervalHistogramSvg buckets={stats.intervalHistogram} />
                </div>
              </div>
            )}
          </StatsCard>
        </div>

        {/* Row 5: Words Learned Over Time + Study Time */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 2h) Words Learned Over Time */}
          <StatsCard
            title="Words Learned Over Time"
            subtitle={
              stats
                ? `Cumulative: ${stats.wordsLearned.totalMature} mature cards · ${stats.wordsLearned.totalKnownWords} known words`
                : undefined
            }
            loading={loading}
            error={error}
            isEmpty={
              !stats ||
              (stats.wordsLearned.totalMature === 0 && stats.wordsLearned.totalKnownWords === 0)
            }
            onRetry={loadStats}
          >
            {stats && <WordsLearnedChartSvg series={stats.wordsLearned.series} />}
          </StatsCard>

          {/* 2i) Study Time */}
          <StatsCard
            title="Study Time"
            subtitle={
              stats
                ? `Total: ${stats.studyTime.totalMinutes} min · Avg ${stats.studyTime.avgMinutesPerActiveDay} min/active day (capped at 60s/review)`
                : undefined
            }
            action={<Clock className="w-4 h-4 text-[var(--text-muted)]" />}
            loading={loading}
            error={error}
            isEmpty={!stats || stats.studyTime.totalMinutes === 0}
            onRetry={loadStats}
          >
            {stats && (
              <DailyMetricBarChartSvg
                points={studyTimePoints}
                unitLabel="min"
                barColor="var(--accent)"
                ariaLabel="Daily study time in minutes"
              />
            )}
          </StatsCard>
        </div>

        {/* Row 6: Hardest Cards + Leeches */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <StatsCard
            title="Hardest Cards (Top 10)"
            subtitle="Sorted by highest lapses and lowest FSRS stability. Tap a real card to edit."
            loading={loading}
            error={error}
            isEmpty={!stats || stats.hardestCards.length === 0}
            onRetry={loadStats}
          >
            {stats && (
              <div className="divide-y divide-[var(--border-subtle)]">
                {stats.hardestCards.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      if (c.cardRef) {
                        setEditingCard(c.cardRef);
                      } else {
                        setNotice('Demo preview cards are read-only and never stored in your deck.');
                      }
                    }}
                    className="w-full py-2.5 px-2 -mx-2 rounded-xl hover:bg-[var(--surface-muted)] text-left flex items-center justify-between gap-3 transition"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-[var(--text)] truncate">
                          {c.word}
                        </span>
                        {c.reading && c.reading !== c.word && (
                          <span className="text-xs text-[var(--text-muted)] truncate">
                            {c.reading}
                          </span>
                        )}
                        {c.isDemo && (
                          <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">
                            Demo
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--text-secondary)] truncate">
                        {c.meaning}
                      </div>
                    </div>

                    <div className="text-right shrink-0 text-xs tabular-nums">
                      <div className="font-bold text-rose-600 dark:text-rose-400">
                        {c.lapses} {c.lapses === 1 ? 'lapse' : 'lapses'}
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)]">
                        S: {c.stability}d · {c.reps} reps
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </StatsCard>

          <StatsCard
            title="Leech Cards"
            subtitle={`Cards tagged #leech or with ≥ ${studySettings.leechThreshold} lapses`}
            action={<AlertTriangle className="w-4 h-4 text-amber-500" />}
            loading={loading}
            error={error}
            isEmpty={!stats || stats.leechCards.length === 0}
            emptyMessage="No leech cards right now. Study some cards to see this if any lapse repeatedly."
            onRetry={loadStats}
          >
            {stats && (
              <div className="divide-y divide-[var(--border-subtle)] max-h-80 overflow-y-auto">
                {stats.leechCards.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      if (c.cardRef) {
                        setEditingCard(c.cardRef);
                      } else {
                        setNotice('Demo preview cards are read-only and never stored in your deck.');
                      }
                    }}
                    className="w-full py-2.5 px-2 -mx-2 rounded-xl hover:bg-[var(--surface-muted)] text-left flex items-center justify-between gap-3 transition"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-[var(--text)] truncate">
                          {c.word}
                        </span>
                        {c.suspended && (
                          <span className="text-[11px] text-[var(--text-muted)]">
                            · Suspended
                          </span>
                        )}
                        {c.isDemo && (
                          <span className="text-[11px] text-amber-600 dark:text-amber-400 font-semibold">
                            · Demo
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--text-secondary)] truncate">
                        {c.meaning}
                      </div>
                    </div>
                    <div className="text-xs font-bold text-amber-600 dark:text-amber-400 tabular-nums shrink-0">
                      {c.lapses} lapses
                    </div>
                  </button>
                ))}
              </div>
            )}
          </StatsCard>
        </div>

        {/* Row 7: Progress by Level */}
        <StatsCard
          title={`Progress by Level (${stats?.levelProgress.systemName || activePack.levelSystem.name})`}
          subtitle="Counts are calculated strictly against the vocabulary and kanji lists currently imported on this device."
          action={<GraduationCap className="w-4 h-4 text-[var(--text-muted)]" />}
          loading={loading}
          error={error}
          isEmpty={
            !stats ||
            (!stats.levelProgress.hasImportedVocab &&
              !stats.levelProgress.hasImportedKanji &&
              stats.levelProgress.rows.every(
                (r) => r.wordsKnownOrLearned === 0 && r.kanjiKnownOrLearned === 0
              ))
          }
          emptyMessage="Study some cards or import level packs in Packs to see this"
          onRetry={loadStats}
        >
          {stats && (
            <div className="space-y-3">
              {(!stats.levelProgress.hasImportedVocab ||
                (stats.levelProgress.supportsKanji && !stats.levelProgress.hasImportedKanji)) && (
                <p className="text-[11px] text-[var(--text-muted)]">
                  {!stats.levelProgress.hasImportedVocab &&
                    'No vocabulary level list imported yet (totals show 0 until imported). '}
                  {stats.levelProgress.supportsKanji &&
                    !stats.levelProgress.hasImportedKanji &&
                    'No kanji level list imported yet (Kanji totals reflect only imported lists).'}
                </p>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[var(--text-muted)] text-left">
                      <th className="py-2 font-semibold">Level</th>
                      <th className="py-2 font-semibold">Words Known / Learned</th>
                      {stats.levelProgress.supportsKanji && (
                        <th className="py-2 font-semibold">Kanji Known / Learned</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)]">
                    {stats.levelProgress.rows.map((row) => {
                      const wordPct =
                        row.wordsImportedTotal > 0
                          ? Math.min(100, Math.round((row.wordsKnownOrLearned / row.wordsImportedTotal) * 100))
                          : 0;
                      const kanjiPct =
                        row.kanjiImportedTotal > 0
                          ? Math.min(100, Math.round((row.kanjiKnownOrLearned / row.kanjiImportedTotal) * 100))
                          : 0;

                      return (
                        <tr key={row.code}>
                          <td className="py-2.5 pr-4 font-bold text-[var(--text)] whitespace-nowrap">
                            {row.isNoLevel ? 'No level' : row.label}
                          </td>
                          <td className="py-2.5 pr-4 min-w-[200px]">
                            <div className="flex items-center justify-between gap-2 mb-1">
                              <span className="font-semibold text-[var(--text)]">
                                {row.wordsKnownOrLearned.toLocaleString()}
                                {row.wordsImportedTotal > 0
                                  ? ` / ${row.wordsImportedTotal.toLocaleString()} imported`
                                  : ' (none imported)'}
                              </span>
                              {row.wordsImportedTotal > 0 && (
                                <span className="text-[var(--text-muted)]">{wordPct}%</span>
                              )}
                            </div>
                            <div className="h-1.5 rounded-full bg-[var(--surface-muted)] overflow-hidden">
                              <div
                                className="h-full bg-indigo-600 dark:bg-indigo-400 rounded-full"
                                style={{ width: `${wordPct}%` }}
                              />
                            </div>
                          </td>
                          {stats.levelProgress.supportsKanji && (
                            <td className="py-2.5 min-w-[200px]">
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="font-semibold text-[var(--text)]">
                                  {row.kanjiKnownOrLearned.toLocaleString()}
                                  {row.kanjiImportedTotal > 0
                                    ? ` / ${row.kanjiImportedTotal.toLocaleString()} imported`
                                    : ' (none imported)'}
                                </span>
                                {row.kanjiImportedTotal > 0 && (
                                  <span className="text-[var(--text-muted)]">{kanjiPct}%</span>
                                )}
                              </div>
                              <div className="h-1.5 rounded-full bg-[var(--surface-muted)] overflow-hidden">
                                <div
                                  className="h-full bg-emerald-600 dark:bg-emerald-400 rounded-full"
                                  style={{ width: `${kanjiPct}%` }}
                                />
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </StatsCard>

        {/* Row 8: Lookups */}
        <StatsCard
          title="Dictionary Lookups"
          subtitle={
            stats
              ? `${stats.lookups.totalUniqueLookedUp} unique words looked up · ${stats.lookups.convertedToCardsCount} became cards (${stats.lookups.conversionPct}%)`
              : undefined
          }
          action={<Search className="w-4 h-4 text-[var(--text-muted)]" />}
          loading={loading}
          error={error}
          isEmpty={
            !stats ||
            (stats.lookups.totalUniqueLookedUp === 0 &&
              stats.lookups.daily.every((d) => d.count === 0))
          }
          emptyMessage="Look up words while reading (or study some cards) to see this"
          onRetry={loadStats}
        >
          {stats && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[var(--text-secondary)]">
                    Lookups per day
                  </span>
                  <span className="font-bold text-indigo-600 dark:text-indigo-400 tabular-nums">
                    Card conversion: {stats.lookups.conversionPct}% ({stats.lookups.convertedToCardsCount}/{stats.lookups.totalUniqueLookedUp})
                  </span>
                </div>
                <DailyMetricBarChartSvg
                  points={lookupDailyPoints}
                  unitLabel="lookups"
                  barColor="#0ea5e9"
                  ariaLabel="Lookups per day bar chart"
                />
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-[var(--text-secondary)]">
                  Top 10 Most-Looked-Up Words
                </div>
                <div className="divide-y divide-[var(--border-subtle)] text-xs">
                  {stats.lookups.topWords.map((w, idx) => (
                    <div key={w.word} className="py-2 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="w-5 text-[11px] font-mono text-[var(--text-muted)] tabular-nums">
                          {idx + 1}.
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-[var(--text)]">{w.word}</span>
                            {w.reading && w.reading !== w.word && (
                              <span className="text-[var(--text-muted)]">{w.reading}</span>
                            )}
                            {w.hasCard && (
                              <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                                · In Cards
                              </span>
                            )}
                          </div>
                          {w.meaning && (
                            <div className="text-[11px] text-[var(--text-muted)] truncate">
                              {w.meaning}
                            </div>
                          )}
                        </div>
                      </div>
                      <span className="font-mono font-bold text-[var(--text)] tabular-nums shrink-0">
                        {w.count}×
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </StatsCard>
      </main>

      {/* Shared Card Edit Modal for Hardest Cards & Leeches */}
      {editingCard && (
        <CardEditModal
          card={editingCard}
          decks={stats?.allDecks || decksForSelect}
          languageId={editingCard.languageId || activeLanguageId}
          onClose={() => setEditingCard(null)}
          onSaved={async () => {
            setEditingCard(null);
            await loadStats();
          }}
          onDeleted={async () => {
            setEditingCard(null);
            await loadStats();
          }}
        />
      )}
    </div>
  );
};
