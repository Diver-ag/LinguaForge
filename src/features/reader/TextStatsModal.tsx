import React, { useMemo } from 'react';
import type { LanguagePack, Token } from '../../core/languagePack';
import type { WordStatusType } from '../../db/db';
import { useAppStore } from '../../store/useAppStore';
import {
  X,
  PieChart,
  Award,
  CheckCircle2,
  BookOpen,
  Sparkles,
  ArrowRight,
} from 'lucide-react';

interface TextStatsModalProps {
  tokens: Token[];
  pack: LanguagePack;
  documentTitle: string;
  onClose: () => void;
  onSelectWord: (token: Token) => void;
}

export const TextStatsModal: React.FC<TextStatsModalProps> = ({
  tokens,
  pack,
  documentTitle,
  onClose,
  onSelectWord,
}) => {
  const { wordStatuses, setWordStatus } = useAppStore();

  const stats = useMemo(() => {
    const wordTokens = tokens.filter((t) => t.isWord && t.surface.trim().length > 0);
    const uniqueMap = new Map<string, Token>();
    for (const t of wordTokens) {
      const key = t.baseForm || t.surface;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, t);
      }
    }

    const uniqueWords = Array.from(uniqueMap.values());
    let knownCount = 0;
    let learningCount = 0;
    let newCount = 0;
    const levelCounts: Record<string, number> = {};

    const unknownList: Token[] = [];

    for (const t of uniqueWords) {
      const key = t.baseForm || t.surface;
      const status: WordStatusType = wordStatuses[key] || 'new';

      if (status === 'known') {
        knownCount++;
      } else if (status === 'learning') {
        learningCount++;
        unknownList.push(t);
      } else {
        newCount++;
        unknownList.push(t);
      }

      if (t.level) {
        levelCounts[t.level] = (levelCounts[t.level] || 0) + 1;
      }
    }

    const totalUnique = uniqueWords.length;
    const knownPercent = totalUnique > 0 ? Math.round((knownCount / totalUnique) * 100) : 0;
    const learningPercent = totalUnique > 0 ? Math.round((learningCount / totalUnique) * 100) : 0;

    // Estimate overall difficulty based on vocabulary levels
    let estimatedDifficulty = 'Beginner (N5)';
    if (levelCounts['N1'] > 2 || levelCounts['N2'] > 5) {
      estimatedDifficulty = 'Advanced (N2 - N1)';
    } else if (levelCounts['N3'] > 3) {
      estimatedDifficulty = 'Intermediate (N3)';
    } else if (levelCounts['N4'] > 4) {
      estimatedDifficulty = 'Elementary (N4)';
    } else if (totalUnique > 0) {
      estimatedDifficulty = 'Beginner (N5)';
    }

    return {
      totalTokens: tokens.length,
      totalWords: wordTokens.length,
      totalUnique,
      knownCount,
      learningCount,
      newCount,
      knownPercent,
      learningPercent,
      levelCounts,
      estimatedDifficulty,
      unknownList,
    };
  }, [tokens, wordStatuses]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden my-8 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-800/40">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-100 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-400 rounded-xl">
              <PieChart className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 dark:text-white text-base">Per-Text Comprehension Stats</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-xs">{documentTitle}</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-6 max-h-[75vh] overflow-y-auto">
          {/* Main gauge & Difficulty card */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Known % Card */}
            <div className="p-4 rounded-xl bg-gradient-to-br from-indigo-50 to-indigo-100/50 dark:from-slate-800/80 dark:to-indigo-950/40 border border-indigo-100 dark:border-indigo-900/50 flex items-center gap-4">
              <div className="relative w-16 h-16 flex items-center justify-center shrink-0">
                <svg className="w-16 h-16 transform -rotate-90" viewBox="0 0 36 36">
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
                <span className="absolute text-sm font-bold text-slate-900 dark:text-white">
                  {stats.knownPercent}%
                </span>
              </div>
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Vocabulary Known</div>
                <div className="text-base font-bold text-slate-900 dark:text-white">
                  {stats.knownCount} / {stats.totalUnique} words
                </div>
                <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                  {stats.knownPercent >= 95 ? 'Easy reading (95%+)' : stats.knownPercent >= 80 ? 'Good for study (80-95%)' : 'Challenging (<80%)'}
                </div>
              </div>
            </div>

            {/* Difficulty Level Card */}
            <div className="p-4 rounded-xl bg-gradient-to-br from-purple-50 to-purple-100/50 dark:from-slate-800/80 dark:to-purple-950/40 border border-purple-100 dark:border-purple-900/50 flex items-center gap-4">
              <div className="p-3 bg-purple-100 dark:bg-purple-950/80 text-purple-600 dark:text-purple-300 rounded-xl shrink-0">
                <Award className="w-8 h-8" />
              </div>
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Difficulty Estimate</div>
                <div className="text-base font-bold text-slate-900 dark:text-white">
                  {stats.estimatedDifficulty}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {stats.totalWords} total word occurrences
                </div>
              </div>
            </div>
          </div>

          {/* Vocabulary breakdown bar */}
          <div className="space-y-2">
            <div className="flex justify-between text-xs font-semibold text-slate-600 dark:text-slate-300">
              <span>Status Distribution</span>
              <span>{stats.totalUnique} unique vocabulary</span>
            </div>
            <div className="h-3 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden flex">
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
                style={{ width: `${100 - stats.knownPercent - stats.learningPercent}%` }}
                className="bg-indigo-500/70 transition-all duration-300"
                title={`New: ${stats.newCount}`}
              />
            </div>
            <div className="flex items-center gap-4 text-xs pt-1">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                <span className="text-slate-600 dark:text-slate-300">Known ({stats.knownCount})</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                <span className="text-slate-600 dark:text-slate-300">Learning ({stats.learningCount})</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-indigo-500/70" />
                <span className="text-slate-600 dark:text-slate-300">New / Unseen ({stats.newCount})</span>
              </div>
            </div>
          </div>

          {/* Interactive Unknown-Word List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-indigo-500" />
                Unknown & Learning Words ({stats.unknownList.length})
              </h4>
              <span className="text-xs text-slate-500">Tap word to inspect</span>
            </div>

            {stats.unknownList.length === 0 ? (
              <div className="p-6 text-center rounded-xl bg-emerald-50/60 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300 text-sm">
                🎉 Great job! You have marked all words in this text as known!
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                {stats.unknownList.map((token) => {
                  const key = token.baseForm || token.surface;
                  const isLearning = wordStatuses[key] === 'learning';

                  return (
                    <div
                      key={token.id}
                      className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 hover:border-indigo-400 dark:hover:border-indigo-600 transition flex items-center justify-between gap-2 group cursor-pointer"
                      onClick={() => {
                        onClose();
                        onSelectWord(token);
                      }}
                    >
                      <div className="space-y-0.5 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-sm text-slate-900 dark:text-slate-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition">
                            {key}
                          </span>
                          {token.reading && (
                            <span className="text-xs text-slate-400 truncate">({token.reading})</span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                          {token.level && (
                            <span className="font-semibold text-sky-600 dark:text-sky-400">{token.level}</span>
                          )}
                          {token.partOfSpeech && <span>• {token.partOfSpeech}</span>}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            await setWordStatus(key, 'known');
                          }}
                          title="Mark as Known"
                          className="p-1 rounded-md text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-slate-700 transition"
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
        <div className="p-4 bg-slate-50 dark:bg-slate-800/40 border-t border-slate-200 dark:border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-xs rounded-xl transition"
          >
            Close Stats
          </button>
        </div>
      </div>
    </div>
  );
};
