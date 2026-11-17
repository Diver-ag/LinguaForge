import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DictionaryEntry, LanguagePack, Token, KanjiDetail } from '../../core/languagePack';
import { type CardType, type ClozeData, type WordStatusType } from '../../db/db';
import {
  addCardsForWord,
  findDuplicateCard,
  findDuplicateClozeCard,
  getDecksWithCounts,
  getDefaultDeckId,
  type DeckWithCount,
} from '../../db/cards';
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
  Pin,
} from 'lucide-react';
import { FuriganaText } from '../../ui/FuriganaText';
import { deriveFrequencyInfo } from '../../packs/japanese/jmdictFrequency';
import { getKanjiDetailsForWord, getHardestKanjiLevel, hasInstalledKanjiData } from '../../packs/japanese/kanjiLookup';
import { isSpeechSynthesisSupported, speakWithReliability } from '../../core/speech';
import { getStudySettings } from '../../core/studySettings';

// Maps JMdict / UniDic / MeCab POS abbreviations to user-friendly names
const POS_EXPANSION_MAP: Record<string, string> = {
  n: 'Noun',
  'n-pref': 'Noun (prefix)',
  'n-suf': 'Noun (suffix)',
  'n-t': 'Noun (temporal)',
  'n-adv': 'Adverbial noun',
  vs: 'Noun / Suru verb',
  'vs-i': 'Suru verb',
  'vs-s': 'Suru verb',
  v1: 'Ichidan verb',
  'v1-s': 'Ichidan verb',
  v5k: 'Godan verb (ku)',
  v5s: 'Godan verb (su)',
  v5t: 'Godan verb (tsu)',
  v5n: 'Godan verb (nu)',
  v5m: 'Godan verb (mu)',
  v5r: 'Godan verb (ru)',
  v5g: 'Godan verb (gu)',
  v5b: 'Godan verb (bu)',
  v5u: 'Godan verb (u)',
  v5: 'Godan verb',
  vk: 'Kuru verb',
  vz: 'Ichidan verb (zuru)',
  'adj-i': 'i-Adjective',
  'adj-na': 'na-Adjective',
  'adj-no': 'no-Adjective',
  'adj-pn': 'Pre-noun adjectival',
  'adj-t': 'taru-Adjective',
  'adj-f': 'Prenominal word',
  adv: 'Adverb',
  'adv-to': 'Adverb (to)',
  exp: 'Expression',
  prt: 'Particle',
  conj: 'Conjunction',
  int: 'Interjection',
  num: 'Number',
  pn: 'Pronoun',
  pref: 'Prefix',
  suf: 'Suffix',
  counter: 'Counter',
  名詞: 'Noun',
  動詞: 'Verb',
  形容詞: 'Adjective',
  助詞: 'Particle',
  助動詞: 'Auxiliary verb',
  副詞: 'Adverb',
  接続詞: 'Conjunction',
  感動詞: 'Interjection',
  連体詞: 'Adnominal',
  接頭詞: 'Prefix',
  記号: 'Symbol',
};

function formatPartOfSpeech(rawPos?: string): string {
  if (!rawPos) return '';
  const parts = rawPos.split(/[,/、\s]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  const formatted = parts.map((p) => {
    const lower = p.toLowerCase();
    return POS_EXPANSION_MAP[lower] || POS_EXPANSION_MAP[p] || p;
  });
  // Filter out stray single ascii characters like lone "n"
  const clean = Array.from(new Set(formatted)).filter((p) => p.length > 1 || !/^[a-z]$/i.test(p));
  return clean.join(', ');
}

interface WordPopupProps {
  token: Token;
  entry: DictionaryEntry | null;
  pack: LanguagePack;
  surroundingSentence?: string;
  tokenSentenceRange?: { start: number; end: number; surface: string } | null;
  documentId?: number;
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
  tokenSentenceRange,
  documentId,
  documentTitle,
  isPinned,
  onClose,
  onStatusChange,
  onMouseEnter,
  onMouseLeave,
}) => {
  const navigate = useNavigate();
  const { wordStatuses, setWordStatus } = useAppStore();
  const [activeTab, setActiveTab] = useState<'meanings' | 'grammar' | 'kanji' | 'examples'>('meanings');
  const [addedFeedback, setAddedFeedback] = useState<{ type: 'added' | 'duplicate' | 'partial'; text: string } | null>(null);
  const [decks, setDecks] = useState<DeckWithCount[]>([]);
  const [selectedDeckId, setSelectedDeckId] = useState<string>(getDefaultDeckId(pack.id));
  const [selectedCardTypes, setSelectedCardTypes] = useState<CardType[]>(['word_to_meaning']);
  const [existingCardTypes, setExistingCardTypes] = useState<Set<CardType>>(new Set());
  const [isAddingCards, setIsAddingCards] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [selectedEntryIndex, setSelectedEntryIndex] = useState(0);
  const [sourceFilter, setSourceFilter] = useState<'all' | 'words' | 'names' | 'kanji' | 'examples'>('all');
  const [kanjiDetails, setKanjiDetails] = useState<KanjiDetail[]>([]);
  const [hasInstalledKanji, setHasInstalledKanji] = useState<boolean>(true);
  const [selectedKanjiChar, setSelectedKanjiChar] = useState<string | null>(null);

  const grouped = entry?.groupedResults;
  const hasMultipleSources = useMemo(() => {
    if (!grouped) return false;
    const nonEmptyGroups = [
      grouped.words.length > 0,
      grouped.names.length > 0,
      grouped.kanji.length > 0,
      grouped.examples.length > 0,
    ].filter(Boolean).length;
    return nonEmptyGroups > 1;
  }, [grouped]);

  // Collect entries ranked by source / priority
  const entriesList = useMemo(() => {
    const all = entry?.allEntries || (entry ? [entry] : []);
    if (sourceFilter === 'all') return all.slice(0, 8);
    if (grouped && grouped[sourceFilter]) {
      return grouped[sourceFilter].slice(0, 8);
    }
    return all.filter((e) => e.sourceKind === sourceFilter).slice(0, 8);
  }, [entry, grouped, sourceFilter]);

  // Reset selected entry index when token or entry changes
  useEffect(() => {
    setSelectedEntryIndex(0);
    setSourceFilter('all');
  }, [token.id, entry?.id]);

  const activeEntryData = entriesList[selectedEntryIndex] || entry;

  // Lemma is dictionary form (baseForm) first, fallback to surface
  const lemma = activeEntryData?.word || entry?.word || token.baseForm || token.surface;
  const currentStatus = wordStatuses[lemma] || wordStatuses[token.surface] || 'new';

  // Load dedicated kanji details from kanjiEntries table (independent from KANJIDIC)
  useEffect(() => {
    let isCancelled = false;
    async function loadKanji() {
      const searchTarget = `${lemma}${token.surface}`;
      const [details, installed] = await Promise.all([
        getKanjiDetailsForWord(searchTarget),
        hasInstalledKanjiData(),
      ]);
      if (!isCancelled) {
        setKanjiDetails(details);
        setHasInstalledKanji(installed);
        if (details.length > 0) {
          setSelectedKanjiChar((prev) => prev || details[0].character);
        }
      }
    }
    loadKanji();
    return () => {
      isCancelled = true;
    };
  }, [lemma, token.surface]);

  const rawReadings = activeEntryData?.readings || entry?.readings || (token.reading ? [token.reading] : []);
  // Filter out any readings that simply echo the kanji surface text without kana pronunciation
  const validReadings = rawReadings.filter(
    (r) => r && r !== lemma && r !== token.surface && !/[\u4e00-\u9faf\u3400-\u4dbf々〆〇]/.test(r)
  );

  const meanings = activeEntryData?.meanings || entry?.meanings || [];
  const rawPos =
    activeEntryData?.partsOfSpeech?.join(', ') ||
    entry?.partsOfSpeech?.join(', ') ||
    token.partOfSpeech ||
    '';
  const pos = formatPartOfSpeech(rawPos);
  const level = activeEntryData?.level || entry?.level || token.level;
  const frequency = activeEntryData?.frequencyRank || entry?.frequencyRank || token.frequencyRank;
  const priorityTags = activeEntryData?.priorityTags || entry?.priorityTags || [];
  const priorityBadge = activeEntryData?.priorityBadge || entry?.priorityBadge;

  const freqInfo = useMemo(() => {
    return deriveFrequencyInfo(priorityTags, frequency);
  }, [priorityTags, frequency]);

  const effectiveFrequencyBand = activeEntryData?.frequencyBand || entry?.frequencyBand || freqInfo.frequencyBand;
  const effectivePriorityBadge = priorityBadge || freqInfo.priorityBadge;
  const kanjiList = entry?.kanjiBreakdown || [];
  const examples = entry?.examples || [];
  const isSampleFallback = activeEntryData?.isSampleFallback ?? entry?.isSampleFallback ?? true;

  const hasWordJlptLevel = Boolean(level && /^N[1-5]$/i.test(level));
  const hardestKanjiLevel = useMemo(() => {
    return getHardestKanjiLevel(kanjiDetails);
  }, [kanjiDetails]);

  const components = token.components || entry?.grammarComponents || [];
  const hasGrammarBreakdown = components.length > 1;

  const validReadingPrimary =
    validReadings[0] ||
    (token.reading &&
    token.reading !== token.surface &&
    !/[\u4e00-\u9faf\u3400-\u4dbf々〆〇]/.test(token.reading)
      ? token.reading
      : '');

  // Load decks for active language
  useEffect(() => {
    let cancelled = false;
    getDecksWithCounts(pack.id)
      .then((list) => {
        if (cancelled) return;
        setDecks(list);
        const defId = getDefaultDeckId(pack.id);
        setSelectedDeckId((prev) =>
          list.some((d) => d.id === prev) ? prev : list.some((d) => d.id === defId) ? defId : list[0]?.id || defId
        );
      })
      .catch(console.warn);
    return () => {
      cancelled = true;
    };
  }, [pack.id]);

  const hasContextSentence = Boolean(surroundingSentence && surroundingSentence.trim().length > 0);
  const canCreateCloze = Boolean(
    hasContextSentence &&
      tokenSentenceRange &&
      tokenSentenceRange.end > tokenSentenceRange.start
  );

  // Automatically deselect 'cloze' if token switches to one without a context sentence
  useEffect(() => {
    if (!canCreateCloze) {
      setSelectedCardTypes((prev) => (prev.includes('cloze') ? prev.filter((t) => t !== 'cloze') : prev));
    }
  }, [canCreateCloze]);

  const ttsSupported = isSpeechSynthesisSupported();

  // Check for existing duplicate cards for (lemma, reading, cardType) and cloze (lemma, sentence, offsets)
  useEffect(() => {
    let cancelled = false;
    setAddedFeedback(null);
    const checkDuplicates = async () => {
      const types: CardType[] = ttsSupported
        ? ['word_to_meaning', 'meaning_to_word', 'reading', 'listening']
        : ['word_to_meaning', 'meaning_to_word', 'reading'];
      const found = new Set<CardType>();
      await Promise.all(
        types.map(async (t) => {
          const match = await findDuplicateCard({
            languageId: pack.id,
            lemma: lemma.trim(),
            reading: validReadingPrimary.trim(),
            cardType: t,
          });
          if (match) found.add(t);
        })
      );

      if (canCreateCloze && surroundingSentence && tokenSentenceRange) {
        const clozeMatch = await findDuplicateClozeCard({
          languageId: pack.id,
          lemma: lemma.trim(),
          sentence: surroundingSentence.trim(),
          start: tokenSentenceRange.start,
          end: tokenSentenceRange.end,
        });
        if (clozeMatch) found.add('cloze');
      }

      if (!cancelled) {
        setExistingCardTypes(found);
      }
    };
    checkDuplicates().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pack.id, lemma, validReadingPrimary, canCreateCloze, surroundingSentence, tokenSentenceRange, ttsSupported]);

  const toggleCardType = (type: CardType) => {
    if (type === 'cloze' && !canCreateCloze) return;
    if (type === 'listening' && !ttsSupported) return;
    setAddedFeedback(null);
    setSelectedCardTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  const allSelectedAreDuplicates =
    selectedCardTypes.length > 0 && selectedCardTypes.every((t) => existingCardTypes.has(t));

  const handleSpeak = async (textToSpeak: string) => {
    if (!ttsSupported) return;
    const settings = await getStudySettings();
    const ttsCode = pack.ttsCode || 'ja-JP';
    const preferredVoiceId =
      settings.speechVoiceByLang[pack.id] || settings.speechVoiceByLang[ttsCode];
    setIsSpeaking(true);
    speakWithReliability({
      text: textToSpeak,
      ttsCode,
      preferredVoiceId,
      rate: settings.speechRate,
      onEnd: () => setIsSpeaking(false),
      onError: () => setIsSpeaking(false),
    });
  };

  const handleSetStatus = async (status: WordStatusType) => {
    await setWordStatus(lemma, status);
    onStatusChange?.(status);
  };

  const handleAddToFlashcards = async () => {
    if (selectedCardTypes.length === 0 || isAddingCards) return;
    setIsAddingCards(true);
    try {
      let sentenceFurigana: any = undefined;
      if (surroundingSentence) {
        try {
          const sentenceTokens = await pack.tokenize(surroundingSentence);
          sentenceFurigana = sentenceTokens.flatMap((t) => t.furiganaSegments || [{ text: t.surface }]);
        } catch {
          // ignore
        }
      }

      const trimmedSentence = (surroundingSentence || '').trim();
      let clozePayload: ClozeData | undefined;
      if (selectedCardTypes.includes('cloze') && canCreateCloze && trimmedSentence && tokenSentenceRange) {
        clozePayload = {
          sentence: trimmedSentence,
          start: tokenSentenceRange.start,
          end: tokenSentenceRange.end,
          answer: token.surface,
          lemma: lemma.trim(),
          reading: validReadingPrimary,
          hint: meanings.join('; ') || 'Definition from reader',
        };
      }

      const { added, duplicateTypes } = await addCardsForWord({
        deckId: selectedDeckId,
        languageId: pack.id,
        cardTypes: selectedCardTypes,
        word: token.surface,
        lemma,
        reading: validReadingPrimary,
        furiganaSegments: token.furiganaSegments,
        meaning: meanings.join('; ') || 'Definition from reader',
        partOfSpeech: pos,
        level: level || '',
        frequencyBand: effectiveFrequencyBand || '',
        sentence: trimmedSentence,
        sentenceFuriganaSegments: sentenceFurigana,
        cloze: clozePayload,
        sourceDocTitle: documentTitle || '',
        sourceDocId: documentId,
      });

      const nextExisting = new Set(existingCardTypes);
      for (const c of added) nextExisting.add(c.cardType);
      for (const d of duplicateTypes) nextExisting.add(d);
      setExistingCardTypes(nextExisting);

      if (added.length === 0 && duplicateTypes.length > 0) {
        setAddedFeedback({ type: 'duplicate', text: 'Already in your cards' });
      } else if (added.length > 0 && duplicateTypes.length > 0) {
        setAddedFeedback({
          type: 'partial',
          text: `Added ${added.length} (${duplicateTypes.length} already in your cards)`,
        });
      } else {
        setAddedFeedback({
          type: 'added',
          text: added.length > 1 ? `Added ${added.length} cards!` : 'Added!',
        });
      }
    } catch (err) {
      console.error('Failed to add card:', err);
    } finally {
      setIsAddingCards(false);
    }
  };

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="w-full max-w-sm sm:max-w-md bg-[var(--surface)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden text-[var(--text)] animate-in fade-in zoom-in-95 duration-100 text-left select-none"
    >
      {/* Header */}
      <div className="p-4 bg-[var(--surface-muted)]/60 border-b border-[var(--border)]">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Primary Dictionary Form with Ruby Furigana */}
              <div className="text-2xl font-bold font-sans text-indigo-900 dark:text-indigo-200">
                {token.furiganaSegments && token.furiganaSegments.length > 0 ? (
                  <FuriganaText
                    segments={token.furiganaSegments}
                    furiganaMode="always"
                    rtClassName="text-xs font-semibold text-indigo-600 dark:text-indigo-400"
                  />
                ) : (
                  <FuriganaText
                    text={lemma}
                    reading={validReadings[0]}
                    furiganaMode="always"
                    rtClassName="text-xs font-semibold text-indigo-600 dark:text-indigo-400"
                  />
                )}
              </div>

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

              {/* JLPT Level: N5-N1 or "No level" */}
              {level && /^N[1-5]$/i.test(level) ? (
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${
                    level.toUpperCase() === 'N5'
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                      : level.toUpperCase() === 'N4'
                      ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/80 dark:text-sky-300 border-sky-300 dark:border-sky-800'
                      : level.toUpperCase() === 'N3'
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300 border-amber-300 dark:border-amber-800'
                      : level.toUpperCase() === 'N2'
                      ? 'bg-orange-100 text-orange-800 dark:bg-orange-950/80 dark:text-orange-300 border-orange-300 dark:border-orange-800'
                      : 'bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300 border-rose-300 dark:border-rose-800'
                  }`}
                >
                  {level.toUpperCase()}
                </span>
              ) : (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                  No level
                </span>
              )}

              {/* Frequency Band Badge */}
              {effectiveFrequencyBand && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-purple-100 text-purple-800 dark:bg-purple-950/90 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                  {effectiveFrequencyBand}
                </span>
              )}

              {/* Priority Badge: "Common (news1, nf08)" or "Uncommon" (hide if duplicate of frequency band) */}
              {effectivePriorityBadge && effectivePriorityBadge !== effectiveFrequencyBand && (
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${
                    effectivePriorityBadge.startsWith('Common')
                      ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/70 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800 font-semibold'
                      : 'bg-slate-100 text-slate-600 dark:bg-slate-800/80 dark:text-slate-400 border border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {effectivePriorityBadge}
                </span>
              )}

              {/* Exact Frequency Rank if available */}
              {frequency && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 font-mono">
                  #{frequency.toLocaleString()}
                </span>
              )}
            </div>

            {/* Reading line: only rendered if a valid non-repeating reading is available */}
            {validReadings.length > 0 && (
              <div className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 flex items-center gap-2 pt-0.5">
                <span>{validReadings.join(' • ')}</span>
                <button
                  onClick={() => handleSpeak(token.surface || lemma)}
                  title="Pronounce with native voice"
                  className="p-1 rounded-full hover:bg-indigo-100 dark:hover:bg-slate-800 text-indigo-600 dark:text-indigo-400 transition"
                >
                  <Volume2 className={`w-3.5 h-3.5 ${isSpeaking ? 'animate-bounce text-emerald-500' : ''}`} />
                </button>
              </div>
            )}

            {/* Hardest kanji estimate line: shown ONLY when word itself has no vocabulary level */}
            {!hasWordJlptLevel && hardestKanjiLevel && (
              <div className="text-[11px] text-slate-500 dark:text-slate-400 italic pt-1 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span>Hardest kanji: <strong className="text-slate-700 dark:text-slate-300">{hardestKanjiLevel}</strong> (estimate)</span>
              </div>
            )}

            {/* Kanji levels row under word header: 1 chip per kanji */}
            {kanjiDetails.length > 0 && (
              <div className="flex items-center gap-1.5 pt-1.5 flex-wrap">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Kanji levels:
                </span>
                {!hasInstalledKanji ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      No kanji list installed.
                    </span>
                    <button
                      onClick={() => {
                        onClose();
                        navigate('/packs');
                      }}
                      className="text-[11px] px-2 py-0.5 rounded-md font-semibold bg-indigo-50 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900 border border-indigo-200 dark:border-indigo-800 transition cursor-pointer"
                    >
                      Import one in Packs
                    </button>
                  </div>
                ) : (
                  kanjiDetails.map((k) => {
                    const kLvl = k.jlptLevel || 'No level';
                    const lvlColor =
                      kLvl === 'N5'
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                        : kLvl === 'N4'
                        ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300 border-sky-200 dark:border-sky-800'
                        : kLvl === 'N3'
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200 dark:border-amber-800'
                        : kLvl === 'N2'
                        ? 'bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300 border-orange-200 dark:border-orange-800'
                        : kLvl === 'N1'
                        ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border-rose-200 dark:border-rose-800'
                        : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700';

                    return (
                      <button
                        key={k.character}
                        onClick={() => {
                          setActiveTab('kanji');
                          setSelectedKanjiChar(k.character);
                        }}
                        className={`text-[11px] px-2 py-0.5 rounded-lg font-bold border transition hover:scale-105 active:scale-95 flex items-center gap-1 cursor-pointer ${lvlColor}`}
                        title={`View details for ${k.character} (${kLvl})`}
                      >
                        <span className="font-bold">{k.character}</span>
                        <span className="text-[10px] opacity-80">{kLvl}</span>
                      </button>
                    );
                  })
                )}
              </div>
            )}

            {/* Source group filter (Words, Names, Kanji, Examples) when results exist from multiple sources */}
            {hasMultipleSources && grouped && (
              <div className="flex items-center gap-1 pt-1.5 mt-1 border-t border-slate-200/50 dark:border-slate-800/60 flex-wrap">
                <span className="text-[10px] font-bold text-slate-400">Source:</span>
                <button
                  onClick={() => { setSourceFilter('all'); setSelectedEntryIndex(0); }}
                  className={`text-[10px] px-2 py-0.5 rounded-full font-bold transition ${
                    sourceFilter === 'all'
                      ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200'
                  }`}
                >
                  All ({entry?.allEntries?.length || entriesList.length})
                </button>
                {grouped.words.length > 0 && (
                  <button
                    onClick={() => { setSourceFilter('words'); setSelectedEntryIndex(0); }}
                    className={`text-[10px] px-2 py-0.5 rounded-full font-bold transition ${
                      sourceFilter === 'words'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100'
                    }`}
                  >
                    Words ({grouped.words.length})
                  </button>
                )}
                {grouped.names.length > 0 && (
                  <button
                    onClick={() => { setSourceFilter('names'); setSelectedEntryIndex(0); }}
                    className={`text-[10px] px-2 py-0.5 rounded-full font-bold transition ${
                      sourceFilter === 'names'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100'
                    }`}
                  >
                    Names ({grouped.names.length})
                  </button>
                )}
                {grouped.kanji.length > 0 && (
                  <button
                    onClick={() => { setSourceFilter('kanji'); setSelectedEntryIndex(0); }}
                    className={`text-[10px] px-2 py-0.5 rounded-full font-bold transition ${
                      sourceFilter === 'kanji'
                        ? 'bg-amber-600 text-white'
                        : 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 hover:bg-amber-100'
                    }`}
                  >
                    Kanji ({grouped.kanji.length})
                  </button>
                )}
                {grouped.examples.length > 0 && (
                  <button
                    onClick={() => { setSourceFilter('examples'); setSelectedEntryIndex(0); }}
                    className={`text-[10px] px-2 py-0.5 rounded-full font-bold transition ${
                      sourceFilter === 'examples'
                        ? 'bg-purple-600 text-white'
                        : 'bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 hover:bg-purple-100'
                    }`}
                  >
                    Examples ({grouped.examples.length})
                  </button>
                )}
              </div>
            )}

            {/* Multiple entries selector (ranked entries) */}
            {entriesList.length > 1 && (
              <div className="flex items-center gap-1.5 pt-1.5 mt-1 border-t border-slate-200/50 dark:border-slate-800/60 flex-wrap">
                <span className="text-[10px] font-bold text-slate-400">Entries ({entriesList.length}):</span>
                {entriesList.map((ent, idx) => (
                  <button
                    key={ent.id || idx}
                    onClick={() => setSelectedEntryIndex(idx)}
                    className={`text-[10px] px-2 py-0.5 rounded-md font-bold transition flex items-center gap-1 ${
                      selectedEntryIndex === idx
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700'
                    }`}
                  >
                    {ent.sourceKind && ent.sourceKind !== 'dictionary' && (
                      <span className={`text-[9px] uppercase px-1 rounded font-semibold ${
                        ent.sourceKind === 'names'
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                          : ent.sourceKind === 'kanji'
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                          : 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300'
                      }`}>
                        {ent.sourceKind === 'names' ? 'Name' : ent.sourceKind}
                      </span>
                    )}
                    <span>#{idx + 1}</span>
                    <span>{ent.word}</span>
                    {ent.readings[0] && ent.readings[0] !== ent.word && (
                      <span className="opacity-75 font-normal">({ent.readings[0]})</span>
                    )}
                  </button>
                ))}
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
        {(pos || token.conjugatedForm) && (
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 font-medium flex items-center gap-2 flex-wrap">
            {pos && <span>{pos}</span>}
            {token.conjugatedForm && (
              <span className="text-indigo-600 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/50 px-2 py-0.5 rounded text-[11px]">
                {token.conjugatedForm}
              </span>
            )}
          </div>
        )}
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
          Definition ({meanings.length})
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

        {(kanjiDetails.length > 0 || kanjiList.length > 0) && (
          <button
            onClick={() => setActiveTab('kanji')}
            className={`flex items-center gap-1 py-2 px-3 border-b-2 font-semibold transition ${
              activeTab === 'kanji'
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Kanji ({kanjiDetails.length || kanjiList.length})
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
            {!hasInstalledKanji && (
              <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex items-center justify-between gap-2">
                <span>No kanji list installed on this device. Import one in Packs.</span>
                <button
                  onClick={() => {
                    onClose();
                    navigate('/packs');
                  }}
                  className="px-2 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold shrink-0 transition"
                >
                  Packs
                </button>
              </div>
            )}
            {(kanjiDetails.length > 0 ? kanjiDetails : kanjiList).map((k, idx) => {
              const isSelected = selectedKanjiChar === k.character;
              return (
                <div
                  key={idx}
                  className={`p-2.5 rounded-xl border transition flex items-start gap-3 ${
                    isSelected
                      ? 'bg-indigo-50/70 dark:bg-indigo-950/40 border-indigo-400 dark:border-indigo-600 ring-2 ring-indigo-500/30'
                      : 'bg-slate-50 dark:bg-slate-800/70 border-slate-200 dark:border-slate-700/60'
                  }`}
                >
                  <div className="w-10 h-10 flex items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 text-xl font-bold shrink-0">
                    {k.character}
                  </div>
                  <div className="space-y-0.5 min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold text-xs text-slate-900 dark:text-slate-100">
                        {k.meanings && k.meanings.length > 0 && k.meanings[0] !== 'Kanji character'
                          ? k.meanings.join(', ')
                          : hasInstalledKanji
                          ? k.meanings?.join(', ') || 'Kanji character'
                          : '(Import kanji list for definitions)'}
                      </span>
                      {k.jlptLevel ? (
                        <span className="text-[10px] px-1.5 py-0.5 font-bold rounded bg-sky-100 dark:bg-sky-950 text-sky-800 dark:text-sky-300">
                          {k.jlptLevel}
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 font-medium rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
                          No level
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap gap-x-2">
                      {k.readings?.on && k.readings.on.length > 0 && <span>音: {k.readings.on.join(', ')}</span>}
                      {k.readings?.kun && k.readings.kun.length > 0 && <span>訓: {k.readings.kun.join(', ')}</span>}
                    </div>
                    <div className="text-[10px] text-slate-400 flex gap-2">
                      {k.strokeCount && <span>Strokes: {k.strokeCount}</span>}
                      {k.radicals && k.radicals.length > 0 && <span>Radical: {k.radicals.join(', ')}</span>}
                      {k.frequencyRank && <span>Freq: #{k.frequencyRank}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
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

      {/* Add to Cards options strip */}
      <div className="px-3 py-2 bg-[var(--surface-muted)]/60 border-t border-[var(--border)] space-y-2 text-[11px]">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-semibold text-[var(--text-muted)] shrink-0">Deck:</span>
            <select
              value={selectedDeckId}
              onChange={(e) => setSelectedDeckId(e.target.value)}
              aria-label="Target deck"
              className="px-2 py-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] text-[11px] font-medium max-w-[160px] truncate focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {decks.length === 0 ? (
                <option value={getDefaultDeckId(pack.id)}>Default</option>
              ) : (
                decks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.cardCount})
                  </option>
                ))
              )}
            </select>
          </div>

          {(addedFeedback?.type === 'duplicate' || (!addedFeedback && allSelectedAreDuplicates)) && (
            <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">
              Already in your cards
            </span>
          )}
          {addedFeedback && addedFeedback.type !== 'duplicate' && (
            <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
              {addedFeedback.text}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {(
            [
              { id: 'word_to_meaning', label: 'Word → Meaning' },
              { id: 'meaning_to_word', label: 'Meaning → Word' },
              { id: 'reading', label: 'Reading' },
              { id: 'cloze', label: 'Cloze' },
              ...(ttsSupported ? [{ id: 'listening' as CardType, label: 'Listening' }] : []),
            ] as { id: CardType; label: string }[]
          ).map((ct) => {
            const isCloze = ct.id === 'cloze';
            const isDisabled = isCloze && !canCreateCloze;
            const checked = !isDisabled && selectedCardTypes.includes(ct.id);
            const alreadyExists = !isDisabled && existingCardTypes.has(ct.id);
            return (
              <label
                key={ct.id}
                title={
                  isDisabled
                    ? 'Cloze requires a context sentence from the reading text'
                    : undefined
                }
                className={`inline-flex items-center gap-1 select-none text-[11px] ${
                  isDisabled
                    ? 'cursor-not-allowed opacity-45 text-[var(--text-muted)]'
                    : 'cursor-pointer text-[var(--text-secondary)]'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isDisabled}
                  onChange={() => toggleCardType(ct.id)}
                  className="rounded border-[var(--border)] text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
                />
                <span className={alreadyExists ? 'opacity-65' : ''}>
                  {ct.label}
                  {alreadyExists ? ' ✓' : ''}
                </span>
              </label>
            );
          })}
        </div>
        {!ttsSupported && (
          <p className="text-[10px] text-[var(--text-muted)]">
            Listening card type hidden: Web Speech API text-to-speech is not supported in this browser.
          </p>
        )}
      </div>

      {/* Action Footer */}
      <div className="p-3 bg-[var(--surface-muted)] border-t border-[var(--border)] flex items-center justify-between gap-2 flex-wrap">
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

          {/* Dictionary Source Indicator */}
          {isSampleFallback ? (
            <span className="text-[10px] text-amber-700 dark:text-amber-300 font-semibold bg-amber-50 dark:bg-amber-950/60 px-2 py-0.5 rounded border border-amber-200 dark:border-amber-800">
              Dictionary: sample only
            </span>
          ) : (
            <span className="text-[10px] text-indigo-700 dark:text-indigo-300 font-semibold bg-indigo-50 dark:bg-indigo-950/60 px-2 py-0.5 rounded border border-indigo-200 dark:border-indigo-800">
              Dictionary: JMdict
            </span>
          )}
        </div>

        <button
          onClick={handleAddToFlashcards}
          disabled={isAddingCards || selectedCardTypes.length === 0}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
            addedFeedback?.type === 'added'
              ? 'bg-emerald-600 text-white'
              : allSelectedAreDuplicates
              ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300 border border-amber-300 dark:border-amber-800 hover:bg-amber-200/70'
              : 'bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 shadow-xs disabled:opacity-50'
          }`}
        >
          <BookmarkPlus className="w-3.5 h-3.5" />
          {isAddingCards
            ? 'Adding...'
            : addedFeedback?.type === 'added'
            ? addedFeedback.text
            : allSelectedAreDuplicates
            ? 'Already in your cards'
            : 'Add to Cards'}
        </button>
      </div>
    </div>
  );
};
