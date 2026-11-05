import React, { useState, useEffect, useMemo } from 'react';
import type { LanguagePack, Token } from '../../core/languagePack';
import { db, type WordStatusType } from '../../db/db';
import { useAppStore } from '../../store/useAppStore';
import { JAPANESE_DICTIONARY_SAMPLE } from '../../packs/japanese/dictionaryData';
import { deriveFrequencyInfo } from '../../packs/japanese/jmdictFrequency';
import {
  X,
  PieChart,
  Award,
  CheckCircle2,
  Sparkles,
  ArrowRight,
  BarChart3,
  TrendingUp,
  Layers,
  Filter,
} from 'lucide-react';

interface TextStatsModalProps {
  tokens: Token[];
  pack: LanguagePack;
  documentTitle: string;
  onClose: () => void;
  onSelectWord: (token: Token) => void;
}

interface WordMeta {
  jlptLevel: string; // 'N5' | 'N4' | 'N3' | 'N2' | 'N1' | 'No level'
  frequencyBand: string; // 'Top 500' | 'Top 1,000' | 'Top 2,500' | 'Top 5,000' | 'Top 10,000+' | 'Uncommon'
  priorityBadge?: string;
  reading?: string;
  gloss?: string;
}

export const TextStatsModal: React.FC<TextStatsModalProps> = ({
  tokens,
  pack,
  documentTitle,
  onClose,
  onSelectWord,
}) => {
  const { wordStatuses, setWordStatus } = useAppStore();
  const [activeTab, setActiveTab] = useState<'overview' | 'jlpt' | 'frequency'>('overview');
  const [selectedLevelFilter, setSelectedLevelFilter] = useState<string>('all');
  const [wordMetaMap, setWordMetaMap] = useState<Record<string, WordMeta>>({});
  const [isLoadingMeta, setIsLoadingMeta] = useState(true);

  // Extract unique word keys
  const uniqueWords = useMemo(() => {
    const wordTokens = tokens.filter((t) => t.isWord && t.surface.trim().length > 0);
    const uniqueMap = new Map<string, Token>();
    for (const t of wordTokens) {
      const key = t.baseForm || t.surface;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, t);
      }
    }
    return Array.from(uniqueMap.values());
  }, [tokens]);

  // Load JLPT and frequency metadata from IndexedDB and sample dictionary
  useEffect(() => {
    let isCancelled = false;

    async function loadMeta() {
      setIsLoadingMeta(true);
      const uniqueKeys = uniqueWords.map((t) => t.baseForm || t.surface);
      if (uniqueKeys.length === 0) {
        setIsLoadingMeta(false);
        return;
      }

      const metaMap: Record<string, WordMeta> = {};

      try {
        const dbEntries = await db.jmdictEntries.where('forms').anyOf(uniqueKeys).toArray();
        const entryByForm = new Map<string, any>();

        for (const entry of dbEntries) {
          for (const form of entry.forms || []) {
            if (!entryByForm.has(form)) {
              entryByForm.set(form, entry);
            }
          }
        }

        for (const t of uniqueWords) {
          const key = t.baseForm || t.surface;
          const entry = entryByForm.get(key) || entryByForm.get(t.surface);

          let jlpt = 'No level';
          let freqBand = 'Uncommon';
          let pBadge = 'Uncommon';
          let reading = t.reading;
          let gloss: string | undefined = undefined;

          if (entry) {
            if (entry.jlptLevel && /^N[1-5]$/i.test(entry.jlptLevel)) {
              jlpt = entry.jlptLevel.toUpperCase();
            }
            if (entry.frequencyBand) {
              freqBand = entry.frequencyBand;
            } else if (entry.priorityTags && entry.priorityTags.length > 0) {
              const derived = deriveFrequencyInfo(entry.priorityTags, entry.frequencyRank);
              freqBand = derived.frequencyBand;
              pBadge = derived.priorityBadge;
            }
            if (entry.readings && entry.readings.length > 0) {
              reading = reading || entry.readings[0];
            }
            if (entry.meanings && entry.meanings.length > 0) {
              gloss = entry.meanings[0];
            }
          }

          // Fallback to sample dictionary if still No level
          if (jlpt === 'No level') {
            const sample = JAPANESE_DICTIONARY_SAMPLE.find(
              (s) => s.word === key || s.word === t.surface || s.readings.includes(key)
            );
            if (sample) {
              if (sample.level && /^N[1-5]$/i.test(sample.level)) {
                jlpt = sample.level.toUpperCase();
              }
              if (freqBand === 'Uncommon' && sample.priorityTags) {
                const derived = deriveFrequencyInfo(sample.priorityTags, sample.frequencyRank);
                freqBand = derived.frequencyBand;
                pBadge = derived.priorityBadge;
              }
              reading = reading || sample.readings[0];
              gloss = gloss || sample.meanings[0];
            }
          }

          metaMap[key] = {
            jlptLevel: jlpt,
            frequencyBand: freqBand,
            priorityBadge: pBadge,
            reading,
            gloss,
          };
        }
      } catch (err) {
        console.warn('Failed to load word metadata for stats:', err);
      }

      if (!isCancelled) {
        setWordMetaMap(metaMap);
        setIsLoadingMeta(false);
      }
    }

    loadMeta();
    return () => {
      isCancelled = true;
    };
  }, [uniqueWords]);

  // Aggregate statistics
  const stats = useMemo(() => {
    let knownCount = 0;
    let learningCount = 0;
    let newCount = 0;

    const jlptCounts: Record<string, number> = {
      N5: 0,
      N4: 0,
      N3: 0,
      N2: 0,
      N1: 0,
      'No level': 0,
    };

    const freqCounts: Record<string, number> = {
      'Top 500': 0,
      'Top 1,000': 0,
      'Top 2,500': 0,
      'Top 5,000': 0,
      'Top 10,000+': 0,
      Uncommon: 0,
    };

    const unknownList: { token: Token; meta: WordMeta }[] = [];

    for (const t of uniqueWords) {
      const key = t.baseForm || t.surface;
      const status: WordStatusType = wordStatuses[key] || 'new';
      const meta = wordMetaMap[key] || {
        jlptLevel: 'No level',
        frequencyBand: 'Uncommon',
        reading: t.reading,
      };

      if (status === 'known') {
        knownCount++;
      } else if (status === 'learning') {
        learningCount++;
        unknownList.push({ token: t, meta });
      } else {
        newCount++;
        unknownList.push({ token: t, meta });
      }

      // JLPT counts
      if (jlptCounts[meta.jlptLevel] !== undefined) {
        jlptCounts[meta.jlptLevel]++;
      } else {
        jlptCounts['No level']++;
      }

      // Frequency band categorization
      const band = meta.frequencyBand;
      if (band === 'Top 500') {
        freqCounts['Top 500']++;
      } else if (band === 'Top 1,000' || band === 'Top 1000') {
        freqCounts['Top 1,000']++;
      } else if (band === 'Top 2,000' || band === 'Top 2,500' || band === 'Top 3,000') {
        freqCounts['Top 2,500']++;
      } else if (
        band === 'Top 3,500' ||
        band === 'Top 4,000' ||
        band === 'Top 4,500' ||
        band === 'Top 5,000' ||
        band === 'Core Vocab' ||
        band === 'Common'
      ) {
        freqCounts['Top 5,000']++;
      } else if (band.startsWith('Top ')) {
        freqCounts['Top 10,000+']++;
      } else {
        freqCounts['Uncommon']++;
      }
    }

    const totalUnique = uniqueWords.length;
    const knownPercent = totalUnique > 0 ? Math.round((knownCount / totalUnique) * 100) : 0;
    const learningPercent = totalUnique > 0 ? Math.round((learningCount / totalUnique) * 100) : 0;

    // Estimate difficulty
    let estimatedDifficulty = 'Beginner (N5)';
    if (jlptCounts['N1'] > 2 || jlptCounts['N2'] > 5) {
      estimatedDifficulty = 'Advanced (N2 - N1)';
    } else if (jlptCounts['N3'] > 3) {
      estimatedDifficulty = 'Intermediate (N3)';
    } else if (jlptCounts['N4'] > 4) {
      estimatedDifficulty = 'Elementary (N4)';
    } else if (totalUnique > 0) {
      estimatedDifficulty = 'Beginner (N5)';
    }

    return {
      totalTokens: tokens.length,
      totalWords: tokens.filter((t) => t.isWord).length,
      totalUnique,
      knownCount,
      learningCount,
      newCount,
      knownPercent,
      learningPercent,
      jlptCounts,
      freqCounts,
      estimatedDifficulty,
      unknownList,
    };
  }, [uniqueWords, tokens, wordStatuses, wordMetaMap]);

  // Filtered unknown words
  const filteredUnknownList = useMemo(() => {
    if (selectedLevelFilter === 'all') return stats.unknownList;
    return stats.unknownList.filter((item) => item.meta.jlptLevel === selectedLevelFilter);
  }, [stats.unknownList, selectedLevelFilter]);

  // Color mapping for JLPT levels
  const jlptColors: Record<string, { bg: string; text: string; bar: string }> = {
    N5: { bg: 'bg-emerald-100 dark:bg-emerald-950/60', text: 'text-emerald-700 dark:text-emerald-300', bar: 'bg-emerald-500' },
    N4: { bg: 'bg-sky-100 dark:bg-sky-950/60', text: 'text-sky-700 dark:text-sky-300', bar: 'bg-sky-500' },
    N3: { bg: 'bg-amber-100 dark:bg-amber-950/60', text: 'text-amber-700 dark:text-amber-300', bar: 'bg-amber-500' },
    N2: { bg: 'bg-orange-100 dark:bg-orange-950/60', text: 'text-orange-700 dark:text-orange-300', bar: 'bg-orange-500' },
    N1: { bg: 'bg-rose-100 dark:bg-rose-950/60', text: 'text-rose-700 dark:text-rose-300', bar: 'bg-rose-500' },
    'No level': { bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-600 dark:text-slate-400', bar: 'bg-slate-400 dark:bg-slate-600' },
  };

  const freqColors: Record<string, string> = {
    'Top 500': 'bg-emerald-500',
    'Top 1,000': 'bg-teal-500',
    'Top 2,500': 'bg-indigo-500',
    'Top 5,000': 'bg-purple-500',
    'Top 10,000+': 'bg-amber-500',
    Uncommon: 'bg-slate-400 dark:bg-slate-600',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl overflow-hidden my-6 animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-800/40 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-100 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-400 rounded-xl">
              <PieChart className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 dark:text-white text-base">
                Text Comprehension & Vocabulary Stats
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-xs sm:max-w-md">
                {documentTitle}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-slate-200 dark:border-slate-800 px-5 pt-3 bg-white dark:bg-slate-900 shrink-0 gap-2">
          <button
            onClick={() => setActiveTab('overview')}
            className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition flex items-center gap-1.5 ${
              activeTab === 'overview'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <PieChart className="w-3.5 h-3.5" />
            Overview & Status
          </button>
          <button
            onClick={() => setActiveTab('jlpt')}
            className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition flex items-center gap-1.5 ${
              activeTab === 'jlpt'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <Award className="w-3.5 h-3.5 text-amber-500" />
            JLPT Level Breakdown
          </button>
          <button
            onClick={() => setActiveTab('frequency')}
            className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition flex items-center gap-1.5 ${
              activeTab === 'frequency'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5 text-teal-500" />
            Frequency Bands
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-6 overflow-y-auto flex-1">
          {/* Top Quick Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Known % Card */}
            <div className="p-4 rounded-2xl bg-gradient-to-br from-emerald-50 to-teal-50/40 dark:from-slate-800/80 dark:to-emerald-950/30 border border-emerald-100 dark:border-emerald-900/40 flex items-center gap-4">
              <div className="relative w-14 h-14 flex items-center justify-center shrink-0">
                <svg className="w-14 h-14 transform -rotate-90" viewBox="0 0 36 36">
                  <path
                    className="text-slate-200 dark:text-slate-700"
                    strokeWidth="3.5"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                  <path
                    className="text-emerald-500"
                    strokeDasharray={`${stats.knownPercent}, 100`}
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                </svg>
                <span className="absolute text-xs font-bold text-slate-900 dark:text-white">
                  {stats.knownPercent}%
                </span>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Vocabulary Known</div>
                <div className="text-base font-bold text-slate-900 dark:text-white">
                  {stats.knownCount} / {stats.totalUnique} words
                </div>
                <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                  {stats.knownPercent >= 95
                    ? 'Easy reading (95%+)'
                    : stats.knownPercent >= 80
                    ? 'Good for study (80-95%)'
                    : 'Challenging (<80%)'}
                </div>
              </div>
            </div>

            {/* Estimated Difficulty Card */}
            <div className="p-4 rounded-2xl bg-gradient-to-br from-indigo-50 to-purple-50/40 dark:from-slate-800/80 dark:to-indigo-950/30 border border-indigo-100 dark:border-indigo-900/40 flex items-center gap-4">
              <div className="p-3 bg-indigo-100 dark:bg-indigo-950/80 text-indigo-600 dark:text-indigo-300 rounded-xl shrink-0">
                <Award className="w-7 h-7" />
              </div>
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Difficulty Estimate</div>
                <div className="text-base font-bold text-slate-900 dark:text-white">
                  {stats.estimatedDifficulty}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {stats.totalWords} total word occurrences ({stats.totalUnique} unique)
                </div>
              </div>
            </div>
          </div>

          {/* TAB 1: OVERVIEW & STATUS */}
          {activeTab === 'overview' && (
            <div className="space-y-5">
              {/* Study Status Distribution */}
              <div className="space-y-2 p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-800">
                <div className="flex justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
                  <span>Vocabulary Status Distribution</span>
                  <span>{stats.totalUnique} unique words</span>
                </div>
                <div className="h-3 w-full bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden flex">
                  <div
                    style={{ width: `${stats.knownPercent}%` }}
                    className="bg-emerald-500 transition-all duration-300"
                    title={`Known: ${stats.knownCount}`}
                  />
                  <div
                    style={{ width: `${stats.learningPercent}%` }}
                    className="bg-amber-500 transition-all duration-300"
                    title={`Learning: ${stats.learningCount}`}
                  />
                  <div
                    style={{ width: `${Math.max(0, 100 - stats.knownPercent - stats.learningPercent)}%` }}
                    className="bg-indigo-500 transition-all duration-300"
                    title={`New: ${stats.newCount}`}
                  />
                </div>
                <div className="flex items-center justify-between text-xs pt-1 flex-wrap gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                    <span className="text-slate-600 dark:text-slate-300">
                      Known: <strong>{stats.knownCount}</strong> ({stats.knownPercent}%)
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                    <span className="text-slate-600 dark:text-slate-300">
                      Learning: <strong>{stats.learningCount}</strong> ({stats.learningPercent}%)
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
                    <span className="text-slate-600 dark:text-slate-300">
                      New: <strong>{stats.newCount}</strong> ({Math.max(0, 100 - stats.knownPercent - stats.learningPercent)}%)
                    </span>
                  </div>
                </div>
              </div>

              {/* Quick Summary of JLPT & Frequency */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2">
                  <span className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <Award className="w-4 h-4 text-amber-500" />
                    JLPT Level Summary
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {(['N5', 'N4', 'N3', 'N2', 'N1', 'No level'] as const).map((lvl) => {
                      const count = stats.jlptCounts[lvl] || 0;
                      if (count === 0) return null;
                      const conf = jlptColors[lvl];
                      return (
                        <span
                          key={lvl}
                          className={`px-2 py-0.5 rounded-lg text-[11px] font-bold border border-slate-200 dark:border-slate-700 ${conf.bg} ${conf.text}`}
                        >
                          {lvl}: {count}
                        </span>
                      );
                    })}
                  </div>
                </div>

                <div className="p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2">
                  <span className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <TrendingUp className="w-4 h-4 text-teal-500" />
                    Frequency Profile
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(stats.freqCounts).map(([band, count]) => {
                      if (count === 0) return null;
                      return (
                        <span
                          key={band}
                          className="px-2 py-0.5 rounded-lg text-[11px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
                        >
                          {band}: {count}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: JLPT BREAKDOWN */}
          {activeTab === 'jlpt' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-bold text-sm text-slate-900 dark:text-white">
                    Breakdown by JLPT Level
                  </h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Distribution of unique vocabulary across official JLPT levels (N5 beginner to N1 advanced).
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                {(['N5', 'N4', 'N3', 'N2', 'N1', 'No level'] as const).map((lvl) => {
                  const count = stats.jlptCounts[lvl] || 0;
                  const pct = stats.totalUnique > 0 ? Math.round((count / stats.totalUnique) * 100) : 0;
                  const conf = jlptColors[lvl];

                  return (
                    <div
                      key={lvl}
                      className="p-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 space-y-1.5"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-black px-2 py-0.5 rounded-lg text-[11px] ${conf.bg} ${conf.text}`}
                          >
                            {lvl}
                          </span>
                          <span className="font-semibold text-slate-700 dark:text-slate-300">
                            {lvl === 'N5'
                              ? 'Beginner'
                              : lvl === 'N4'
                              ? 'Elementary'
                              : lvl === 'N3'
                              ? 'Intermediate'
                              : lvl === 'N2'
                              ? 'Pre-Advanced'
                              : lvl === 'N1'
                              ? 'Advanced'
                              : 'Uncategorized / No level'}
                          </span>
                        </div>
                        <div className="font-mono text-slate-600 dark:text-slate-400">
                          <strong>{count}</strong> words ({pct}%)
                        </div>
                      </div>

                      <div className="h-2 w-full bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div
                          style={{ width: `${pct}%` }}
                          className={`h-full ${conf.bar} transition-all duration-300`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: FREQUENCY BREAKDOWN */}
          {activeTab === 'frequency' && (
            <div className="space-y-4">
              <div>
                <h4 className="font-bold text-sm text-slate-900 dark:text-white">
                  Breakdown by Frequency Band
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Calculated from JMdict priority corpus tags (news1/2, ichi1/2, nfXX) and imported frequency lists.
                </p>
              </div>

              <div className="space-y-3">
                {Object.entries(stats.freqCounts).map(([band, count]) => {
                  const pct = stats.totalUnique > 0 ? Math.round((count / stats.totalUnique) * 100) : 0;
                  const barColor = freqColors[band] || 'bg-indigo-500';

                  return (
                    <div
                      key={band}
                      className="p-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 space-y-1.5"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-bold font-mono px-2 py-0.5 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-200 text-[11px]">
                            {band}
                          </span>
                          <span className="text-slate-500 dark:text-slate-400 text-[11px]">
                            {band === 'Top 500'
                              ? 'Highest frequency core vocabulary'
                              : band === 'Top 1,000'
                              ? 'Everyday common vocabulary'
                              : band === 'Top 2,500'
                              ? 'Standard conversational vocabulary'
                              : band === 'Top 5,000'
                              ? 'Broad reading vocabulary'
                              : band === 'Top 10,000+'
                              ? 'Specific or literary vocabulary'
                              : 'Low frequency / rare expressions'}
                          </span>
                        </div>
                        <div className="font-mono text-slate-600 dark:text-slate-400">
                          <strong>{count}</strong> words ({pct}%)
                        </div>
                      </div>

                      <div className="h-2 w-full bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div
                          style={{ width: `${pct}%` }}
                          className={`h-full ${barColor} transition-all duration-300`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Interactive Unknown & Learning Words Section */}
          <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-indigo-500" />
                Unknown & Learning Words ({filteredUnknownList.length})
              </h4>

              {/* Level Filter Chips */}
              <div className="flex items-center gap-1 overflow-x-auto text-[11px]">
                <span className="text-slate-400 flex items-center gap-0.5 mr-1">
                  <Filter className="w-3 h-3" /> Filter:
                </span>
                {['all', 'N5', 'N4', 'N3', 'N2', 'N1', 'No level'].map((lvl) => (
                  <button
                    key={lvl}
                    onClick={() => setSelectedLevelFilter(lvl)}
                    className={`px-2 py-0.5 rounded-lg font-semibold transition ${
                      selectedLevelFilter === lvl
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200'
                    }`}
                  >
                    {lvl === 'all' ? 'All' : lvl}
                  </button>
                ))}
              </div>
            </div>

            {filteredUnknownList.length === 0 ? (
              <div className="p-6 text-center rounded-2xl bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300 text-xs">
                {selectedLevelFilter === 'all'
                  ? '🎉 Excellent! All words in this text are marked as known.'
                  : `No unknown words found for level ${selectedLevelFilter}.`}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1">
                {filteredUnknownList.map(({ token, meta }) => {
                  const key = token.baseForm || token.surface;
                  const isLearning = wordStatuses[key] === 'learning';
                  const conf = jlptColors[meta.jlptLevel] || jlptColors['No level'];

                  return (
                    <div
                      key={token.id}
                      className="p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 hover:border-indigo-400 dark:hover:border-indigo-600 transition flex items-center justify-between gap-2 group cursor-pointer"
                      onClick={() => {
                        onClose();
                        onSelectWord(token);
                      }}
                    >
                      <div className="space-y-0.5 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-bold text-sm text-slate-900 dark:text-slate-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition">
                            {key}
                          </span>
                          {meta.reading && (
                            <span className="text-xs text-slate-400 truncate">({meta.reading})</span>
                          )}
                        </div>

                        <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`px-1.5 py-0.2 rounded font-bold text-[10px] ${conf.bg} ${conf.text}`}
                          >
                            {meta.jlptLevel}
                          </span>
                          <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                            {meta.frequencyBand}
                          </span>
                          {meta.gloss && (
                            <span className="truncate max-w-[120px] text-slate-400">
                              • {meta.gloss}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            await setWordStatus(key, 'known');
                          }}
                          title="Mark as Known"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-slate-700 transition"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                        </button>
                        <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:translate-x-0.5 transition" />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-50 dark:bg-slate-800/40 border-t border-slate-200 dark:border-slate-800 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl transition shadow-xs"
          >
            Close Stats
          </button>
        </div>
      </div>
    </div>
  );
};

