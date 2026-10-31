import React, { useState } from 'react';
import type { DictionaryEntry, LanguagePack, Token } from '../../core/languagePack';
import { db, type WordStatusType } from '../../db/db';
import { useAppStore } from '../../store/useAppStore';
import {
  Volume2,
  BookmarkPlus,
  CheckCircle,
  X,
  BookOpen,
  Sparkles,
  Layers,
  GitFork,
  HelpCircle,
  Pin,
} from 'lucide-react';

interface WordPopupProps {
  token: Token;
  entry: DictionaryEntry | null;
  pack: LanguagePack;
  surroundingSentence?: string;
  documentTitle?: string;
  isPinned?: boolean;
  onClose: () => void;
  onStatusChange?: (newStatus: WordStatusType) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export const WordPopup: React.FC<WordPopupProps> = ({
  token,
  entry,
  pack,
  surroundingSentence,
  documentTitle,
  isPinned,
  onClose,
  onStatusChange,
  onMouseEnter,
  onMouseLeave,
}) => {
  const { wordStatuses, setWordStatus } = useAppStore();
  const [activeTab, setActiveTab] = useState<'meanings' | 'grammar' | 'kanji' | 'examples'>('meanings');
  const [addedToCards, setAddedToCards] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Lemma is dictionary form (baseForm) first, fallback to surface
  const lemma = entry?.word || token.baseForm || token.surface;
  const currentStatus = wordStatuses[lemma] || wordStatuses[token.surface] || 'new';

  const readings = entry?.readings || (token.reading ? [token.reading] : []);
  const meanings = entry?.meanings || [];
  const pos = entry?.partsOfSpeech?.join(', ') || token.partOfSpeech || 'Word';
  const level = entry?.level || token.level;
  const frequency = entry?.frequencyRank || token.frequencyRank;
  const kanjiList = entry?.kanjiBreakdown || [];
  const examples = entry?.examples || [];

  const components = token.components || entry?.grammarComponents || [];
  const hasGrammarBreakdown = components.length > 1;

  const handleSpeak = (textToSpeak: string) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(textToSpeak);
      utterance.lang = pack.ttsCode || 'ja-JP';
      utterance.rate = 0.85;
      setIsSpeaking(true);
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleSetStatus = async (status: WordStatusType) => {
    await setWordStatus(lemma, status);
    onStatusChange?.(status);
  };

  const handleAddToFlashcards = async () => {
    try {
      await db.flashcards.add({
        word: lemma,
        reading: readings[0] || lemma,
        meaning: meanings.join('; ') || 'Definition from reader',
        sentence: surroundingSentence,
        languageId: pack.id,
        sourceDocTitle: documentTitle,
        level,
        status: 'new',
        createdAt: Date.now(),
      });
      setAddedToCards(true);
      setTimeout(() => setAddedToCards(false), 3000);
    } catch (err) {
      console.error('Failed to add flashcard:', err);
    }
  };

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="w-full max-w-sm sm:max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden text-slate-900 dark:text-slate-100 animate-in fade-in zoom-in-95 duration-100 text-left select-none"
    >
      {/* Header */}
      <div className="p-4 bg-gradient-to-r from-indigo-50/90 to-purple-50/90 dark:from-slate-800/90 dark:to-indigo-950/40 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Primary Dictionary Form (Lemma) */}
              <span className="text-2xl font-bold font-sans tracking-wide text-indigo-900 dark:text-indigo-200">
                {lemma}
              </span>

              {/* Note if surface in text is a conjugated form */}
              {token.surface !== lemma && (
                <span className="text-xs px-2 py-0.5 rounded-md font-medium bg-indigo-100 text-indigo-800 dark:bg-indigo-950/80 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                  in text: <strong className="font-bold">{token.surface}</strong>
                </span>
              )}

              {/* Status pill */}
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                  currentStatus === 'known'
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300'
                    : currentStatus === 'learning'
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300'
                    : currentStatus === 'ignored'
                    ? 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-400'
                    : 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-300'
                }`}
              >
                {currentStatus}
              </span>

              {level && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-sky-100 text-sky-800 dark:bg-sky-950/80 dark:text-sky-300">
                  {level}
                </span>
              )}

              {frequency && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 font-mono">
                  #{frequency}
                </span>
              )}
            </div>

            {readings.length > 0 && (
              <div className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 flex items-center gap-2">
                <span>{readings.join(' • ')}</span>
                <button
                  onClick={() => handleSpeak(token.surface || lemma)}
                  title="Pronounce with native voice"
                  className="p-1 rounded-full hover:bg-indigo-100 dark:hover:bg-slate-800 text-indigo-600 dark:text-indigo-400 transition"
                >
                  <Volume2 className={`w-3.5 h-3.5 ${isSpeaking ? 'animate-bounce text-emerald-500' : ''}`} />
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {isPinned && (
              <span title="Pinned" className="text-indigo-600 dark:text-indigo-400 p-1">
                <Pin className="w-3.5 h-3.5 fill-current" />
              </span>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition"
              title="Close Popup"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Part of speech & Conjugation info */}
        <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 font-medium flex items-center gap-2 flex-wrap">
          <span>{pos}</span>
          {token.conjugatedForm && (
            <span className="text-indigo-600 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/50 px-2 py-0.5 rounded text-[11px]">
              {token.conjugatedForm}
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 px-2 text-xs">
        <button
          onClick={() => setActiveTab('meanings')}
          className={`flex items-center gap-1 py-2 px-3 border-b-2 font-semibold transition ${
            activeTab === 'meanings'
              ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400'
              : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'
          }`}
        >
          <BookOpen className="w-3.5 h-3.5" />
          Definition
        </button>

        {hasGrammarBreakdown && (
          <button
            onClick={() => setActiveTab('grammar')}
            className={`flex items-center gap-1 py-2 px-3 border-b-2 font-semibold transition ${
              activeTab === 'grammar'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'
            }`}
          >
            <GitFork className="w-3.5 h-3.5" />
            Breakdown ({components.length})
          </button>
        )}

        {kanjiList.length > 0 && (
          <button
            onClick={() => setActiveTab('kanji')}
            className={`flex items-center gap-1 py-2 px-3 border-b-2 font-semibold transition ${
              activeTab === 'kanji'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Kanji ({kanjiList.length})
          </button>
        )}

        {examples.length > 0 && (
          <button
            onClick={() => setActiveTab('examples')}
            className={`flex items-center gap-1 py-2 px-3 border-b-2 font-semibold transition ${
              activeTab === 'examples'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            Examples ({examples.length})
          </button>
        )}
      </div>

      {/* Tab Contents */}
      <div className="p-4 max-h-56 overflow-y-auto space-y-3 text-sm select-text">
        {activeTab === 'meanings' && (
          <div>
            {meanings.length > 0 ? (
              <ol className="space-y-1.5 list-decimal list-inside text-slate-700 dark:text-slate-200 text-xs sm:text-sm">
                {meanings.map((m, idx) => (
                  <li key={idx} className="leading-relaxed">
                    <span>{m}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="py-3 text-center text-slate-500 dark:text-slate-400 text-xs">
                No offline definitions found for "{lemma}". You can mark it or lookup online.
              </div>
            )}

            {entry?.grammarNotes && entry.grammarNotes.length > 0 && (
              <div className="mt-3 p-2.5 bg-indigo-50/60 dark:bg-indigo-950/30 rounded-lg border border-indigo-100 dark:border-indigo-900/50 text-xs text-indigo-900 dark:text-indigo-300">
                <span className="font-semibold block mb-0.5">Grammar Note:</span>
                {entry.grammarNotes.join(' ')}
              </div>
            )}

            {surroundingSentence && (
              <div className="mt-3 p-2 bg-slate-50 dark:bg-slate-800/60 rounded-lg text-xs">
                <span className="text-slate-400 font-semibold block mb-0.5">Context:</span>
                <span className="text-slate-600 dark:text-slate-300 italic">"{surroundingSentence}"</span>
              </div>
            )}
          </div>
        )}

        {activeTab === 'grammar' && (
          <div className="space-y-3 text-xs">
            {/* Equation representation: 食べる + て + いる + ます */}
            <div className="p-3 bg-indigo-50/70 dark:bg-indigo-950/40 rounded-xl border border-indigo-100 dark:border-indigo-900/40">
              <span className="font-semibold text-indigo-800 dark:text-indigo-300 block mb-1">
                Compound Structure:
              </span>
              <div className="flex items-center gap-1.5 flex-wrap font-bold text-slate-900 dark:text-white">
                {components.map((c, i) => (
                  <React.Fragment key={i}>
                    <span className="px-2 py-0.5 rounded bg-white dark:bg-slate-800 border border-indigo-200 dark:border-indigo-800 shadow-xs">
                      {c.surface}
                    </span>
                    {i < components.length - 1 && (
                      <span className="text-indigo-500 font-normal">+</span>
                    )}
                  </React.Fragment>
                ))}
              </div>
            </div>

            {/* List of sub-parts */}
            <div className="space-y-1.5">
              {components.map((c, idx) => (
                <div
                  key={idx}
                  className="p-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 flex items-center justify-between"
                >
                  <div>
                    <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                      <span>{c.surface}</span>
                      {c.basic && c.basic !== c.surface && c.basic !== '*' && (
                        <span className="text-indigo-600 dark:text-indigo-400 font-normal text-[11px]">
                          (dictionary: {c.basic})
                        </span>
                      )}
                    </div>
                    {c.reading && <span className="text-[10px] text-slate-400">{c.reading}</span>}
                  </div>
                  <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 bg-slate-200/60 dark:bg-slate-700/60 px-2 py-0.5 rounded">
                    {c.pos}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'kanji' && (
          <div className="space-y-2.5">
            {kanjiList.map((k, idx) => (
              <div
                key={idx}
                className="p-2.5 bg-slate-50 dark:bg-slate-800/70 rounded-xl border border-slate-200 dark:border-slate-700/60 flex items-start gap-3"
              >
                <div className="w-10 h-10 flex items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 text-xl font-bold shrink-0">
                  {k.character}
                </div>
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold text-xs text-slate-900 dark:text-slate-100">
                      {k.meanings.join(', ')}
                    </span>
                    {k.jlptLevel && (
                      <span className="text-[10px] px-1.5 py-0.5 font-bold rounded bg-sky-100 dark:bg-sky-950 text-sky-800 dark:text-sky-300">
                        {k.jlptLevel}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap gap-x-2">
                    {k.readings.on && k.readings.on.length > 0 && <span>音: {k.readings.on.join(', ')}</span>}
                    {k.readings.kun && k.readings.kun.length > 0 && <span>訓: {k.readings.kun.join(', ')}</span>}
                  </div>
                  <div className="text-[10px] text-slate-400 flex gap-2">
                    {k.strokeCount && <span>Strokes: {k.strokeCount}</span>}
                    {k.radicals && k.radicals.length > 0 && <span>Radical: {k.radicals.join(', ')}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'examples' && (
          <div className="space-y-2">
            {examples.map((ex, idx) => (
              <div
                key={idx}
                className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 text-xs space-y-1"
              >
                <p className="font-medium text-slate-900 dark:text-slate-100">{ex.original}</p>
                {ex.reading && <p className="text-[11px] text-indigo-500 dark:text-indigo-400">{ex.reading}</p>}
                <p className="text-slate-500 dark:text-slate-400">{ex.translation}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action Footer */}
      <div className="p-3 bg-slate-50 dark:bg-slate-900/80 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => handleSetStatus(currentStatus === 'known' ? 'learning' : 'known')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              currentStatus === 'known'
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950/70 dark:text-emerald-300'
            }`}
          >
            <CheckCircle className="w-3.5 h-3.5" />
            {currentStatus === 'known' ? 'Known ✓' : 'Mark Known'}
          </button>

          <button
            onClick={() => handleSetStatus('learning')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
              currentStatus === 'learning'
                ? 'bg-amber-500 text-white'
                : 'bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-300'
            }`}
          >
            Learning
          </button>
        </div>

        <button
          onClick={handleAddToFlashcards}
          disabled={addedToCards}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
            addedToCards
              ? 'bg-emerald-500 text-white cursor-default'
              : 'bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 shadow-xs'
          }`}
        >
          <BookmarkPlus className="w-3.5 h-3.5" />
          {addedToCards ? 'Added!' : 'Add to Cards'}
        </button>
      </div>
    </div>
  );
};
