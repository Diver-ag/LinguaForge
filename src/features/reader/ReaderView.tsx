import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { packSupportsRuby, type DictionaryEntry, type Token } from '../../core/languagePack';
import { db, type WordStatusType } from '../../db/db';
import { addCardsForWord } from '../../db/cards';
import { getLanguagePack } from '../../packs/registry';
import { useAppStore, type FuriganaMode, type FontSize } from '../../store/useAppStore';
import { getTokenizerWarning } from '../../packs/japanese/tokenizer';
import { extractSentenceWithOffsets } from '../../core/cloze';
import { WordPopup } from './WordPopup';
import { TextStatsModal } from './TextStatsModal';
import { FuriganaText } from '../../ui/FuriganaText';
import { JAPANESE_DICTIONARY_SAMPLE } from '../../packs/japanese/dictionaryData';
import { PROTECTED_JA_GRAMMAR_TOKENS } from '../../packs/japanese/deinflector';
import {
  BookOpen,
  ArrowLeft,
  PieChart,
  Eye,
  Type,
  Sparkles,
  Volume2,
  AlertCircle,
  X,
  Loader2,
  Settings,
  Copy,
  BookmarkPlus,
  Check,
} from 'lucide-react';

export const ReaderView: React.FC = () => {
  const navigate = useNavigate();
  const {
    activeLanguageId,
    activeDocument,
    wordStatuses,
    furiganaMode,
    colorCodingEnabled,
    jlptUnderlineEnabled,
    fontSize,
    setFuriganaMode,
    setFontSize,
    recordLookup,
    setActiveDocument,
  } = useAppStore();

  const pack = useMemo(() => getLanguagePack(activeLanguageId), [activeLanguageId]);
  const supportsRuby = packSupportsRuby(pack);

  // Loading & token states
  const [tokens, setTokens] = useState<Token[]>([]);
  const [isTokenizing, setIsTokenizing] = useState(false);
  const [wordJlptLevels, setWordJlptLevels] = useState<Record<string, string>>({});

  // Popup & active token state
  const [activeToken, setActiveToken] = useState<Token | null>(null);
  const [activeEntry, setActiveEntry] = useState<DictionaryEntry | null>(null);
  const [surroundingSentence, setSurroundingSentence] = useState<string>('');
  const [tokenSentenceRange, setTokenSentenceRange] = useState<{
    start: number;
    end: number;
    surface: string;
  } | null>(null);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number; showAbove?: boolean } | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const [isHoveringPopup, setIsHoveringPopup] = useState(false);

  // Timers for flicker-free hover
  const hoverTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  // Text Stats modal
  const [showStatsModal, setShowStatsModal] = useState(false);

  // Phrase selection state
  const [selectedPhrase, setSelectedPhrase] = useState<string>('');
  const [selectionContextSentence, setSelectionContextSentence] = useState<string>('');
  const [copyToast, setCopyToast] = useState(false);
  const [phraseCardToast, setPhraseCardToast] = useState(false);

  // TTS status
  const [isSpeakingAll, setIsSpeakingAll] = useState(false);

  // Load document if not set
  useEffect(() => {
    async function loadDoc() {
      if (!activeDocument) {
        const recent = await db.documents.where('languageId').equals(activeLanguageId).reverse().first();
        if (recent) {
          setActiveDocument(recent);
        } else {
          navigate('/library');
        }
      }
    }
    loadDoc();
  }, [activeDocument, activeLanguageId, navigate, setActiveDocument]);

  // Tokenize document content ONCE and cache per document
  useEffect(() => {
    let isCancelled = false;
    async function runTokenization() {
      if (!activeDocument?.content) return;
      setIsTokenizing(true);
      try {
        const cacheKey = `doc:${activeDocument.id ?? 'unid'}:${activeDocument.content.length}`;
        const result = await pack.tokenize(activeDocument.content);
        if (!isCancelled) {
          setTokens(result);
          setIsTokenizing(false);
        }
      } catch (err) {
        console.error('Tokenization failed:', err);
        if (!isCancelled) setIsTokenizing(false);
      }
    }

    runTokenization();
    return () => {
      isCancelled = true;
    };
  }, [activeDocument, pack]);

  // Resolve JLPT levels for unique words in Japanese documents
  useEffect(() => {
    let isCancelled = false;
    async function resolveWordLevels() {
      if (activeLanguageId !== 'ja') {
        setWordJlptLevels({});
        return;
      }
      if (!tokens || tokens.length === 0) return;
      const uniqueKeys = Array.from(
        new Set(tokens.filter((t) => t.isWord).map((t) => t.baseForm || t.surface))
      );
      if (uniqueKeys.length === 0) return;

      const map: Record<string, string> = {};
      const queryKeys: string[] = [];

      for (const w of uniqueKeys) {
        const pInfo = PROTECTED_JA_GRAMMAR_TOKENS[w];
        if (pInfo) {
          map[w] = pInfo.level;
        } else {
          queryKeys.push(w);
        }
      }

      if (queryKeys.length > 0) {
        try {
          const matches = await db.jmdictEntries.where('forms').anyOf(queryKeys).toArray();
          for (const entry of matches) {
            if (entry.jlptLevel && /^N[1-5]$/i.test(entry.jlptLevel)) {
              const cleanLvl = entry.jlptLevel.toUpperCase();
              for (const f of entry.forms) {
                if (!PROTECTED_JA_GRAMMAR_TOKENS[f] && !map[f]) {
                  map[f] = cleanLvl;
                }
              }
            }
          }
        } catch (err) {
          console.warn('Failed to resolve word levels:', err);
        }
      }

      // Fallback to sample dictionary for remaining
      for (const w of queryKeys) {
        if (!map[w]) {
          const sample = JAPANESE_DICTIONARY_SAMPLE.find((e) => e.word === w || e.readings.includes(w));
          if (sample?.level && /^N[1-5]$/i.test(sample.level)) {
            map[w] = sample.level.toUpperCase();
          }
        }
      }

      if (!isCancelled) {
        setWordJlptLevels(map);
      }
    }

    resolveWordLevels();
    return () => {
      isCancelled = true;
    };
  }, [tokens, activeLanguageId]);

  // Helper to extract surrounding sentence
  const extractSurroundingSentence = useCallback((fullText: string, charIndex: number): string => {
    if (!fullText) return '';
    const delimiters = /[。！？\n.!?]/;
    let start = charIndex;
    while (start > 0 && !delimiters.test(fullText[start - 1])) {
      start--;
    }
    let end = charIndex;
    while (end < fullText.length && !delimiters.test(fullText[end])) {
      end++;
    }
    return fullText.slice(start, Math.min(fullText.length, end + 1)).trim();
  }, []);

  // Calculate popup screen coordinates
  const calculatePopupPosition = (rect: DOMRect) => {
    const popupWidth = Math.min(380, window.innerWidth - 32);
    let x = rect.left;
    if (x + popupWidth > window.innerWidth - 16) {
      x = window.innerWidth - popupWidth - 16;
    }
    if (x < 16) x = 16;

    let y = rect.bottom + 8;
    let showAbove = false;
    if (y + 280 > window.innerHeight && rect.top > 280) {
      y = Math.max(16, rect.top - 8);
      showAbove = true;
    }

    return { x, y, showAbove };
  };

  // Hover Handler attached to the whole token element
  const handleTokenMouseEnter = (token: Token, event: React.MouseEvent) => {
    // If user is currently dragging to select text across tokens, do not popup
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;

    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    // If this token is already the active one, no re-trigger / no flicker
    if (activeToken?.id === token.id) return;

    // If pinned by click, do not override with hover
    if (isPinned) return;

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();

    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }

    hoverTimerRef.current = window.setTimeout(async () => {
      const entry = await pack.lookup(token.surface, token.baseForm);
      const fullText = activeDocument?.content || '';
      const withOffsets = extractSentenceWithOffsets(fullText, token.startIndex, token.endIndex);
      const sentence =
        withOffsets?.sentence ?? extractSurroundingSentence(fullText, token.startIndex);

      setActiveToken(token);
      setActiveEntry(entry);
      setSurroundingSentence(sentence);
      setTokenSentenceRange(
        withOffsets
          ? {
              start: withOffsets.start,
              end: withOffsets.end,
              surface: token.surface,
            }
          : null
      );
      setPopupPos(calculatePopupPosition(rect));
    }, 70);
  };

  const handleTokenMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }

    if (isPinned) return;

    closeTimerRef.current = window.setTimeout(() => {
      if (!isHoveringPopup) {
        setActiveToken(null);
        setActiveEntry(null);
        setPopupPos(null);
      }
    }, 220);
  };

  // Click/Tap Handler: immediately resolves token, locks popup and records lookup
  const handleTokenClick = async (token: Token, event: React.MouseEvent) => {
    // Ignore clicks on punctuation
    if (!token.isWord && !token.reading) return;

    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const entry = await pack.lookup(token.surface, token.baseForm);
    const fullText = activeDocument?.content || '';
    const withOffsets = extractSentenceWithOffsets(fullText, token.startIndex, token.endIndex);
    const sentence =
      withOffsets?.sentence ?? extractSurroundingSentence(fullText, token.startIndex);

    setActiveToken(token);
    setActiveEntry(entry);
    setSurroundingSentence(sentence);
    setTokenSentenceRange(
      withOffsets
        ? {
            start: withOffsets.start,
            end: withOffsets.end,
            surface: token.surface,
          }
        : null
    );
    setIsPinned(true);
    setPopupPos(calculatePopupPosition(rect));

    // Record lookup in Dexie
    const lemmaOrSurface = token.baseForm || token.surface;
    await recordLookup(
      lemmaOrSurface,
      entry?.readings?.[0] || token.reading,
      entry?.meanings?.[0],
      activeDocument?.id,
      activeDocument?.title,
      sentence
    );
  };

  const handleClosePopup = () => {
    setIsPinned(false);
    setIsHoveringPopup(false);
    setActiveToken(null);
    setActiveEntry(null);
    setPopupPos(null);
  };

  // Multi-word phrase selection
  const handleMouseUp = () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      const selectedText = selection.toString().trim();
      if (selectedText.length > 1 && !selectedPhrase) {
        setSelectedPhrase(selectedText);
        const sentence = extractSurroundingSentence(activeDocument?.content || '', selection.anchorOffset);
        setSelectionContextSentence(sentence);
      }
    }
  };

  const handleCopyPhrase = async () => {
    if (!selectedPhrase) return;
    try {
      await navigator.clipboard.writeText(selectedPhrase);
      setCopyToast(true);
      setTimeout(() => {
        setCopyToast(false);
        setSelectedPhrase('');
      }, 1200);
    } catch (err) {
      console.warn('Failed to copy phrase:', err);
    }
  };

  const handleAddPhraseCard = async () => {
    if (!selectedPhrase) return;
    try {
      await addCardsForWord({
        languageId: activeLanguageId,
        cardTypes: ['word_to_meaning'],
        word: selectedPhrase,
        lemma: selectedPhrase,
        reading: '',
        meaning: 'Selected phrase',
        sentence: selectionContextSentence,
        sourceDocTitle: activeDocument?.title,
        sourceDocId: activeDocument?.id,
      });
      setPhraseCardToast(true);
      setTimeout(() => {
        setPhraseCardToast(false);
        setSelectedPhrase('');
      }, 1200);
    } catch (err) {
      console.warn('Failed to add phrase card:', err);
    }
  };

  const handleSpeakText = () => {
    if ('speechSynthesis' in window && activeDocument?.content) {
      window.speechSynthesis.cancel();
      if (isSpeakingAll) {
        setIsSpeakingAll(false);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(activeDocument.content.slice(0, 300));
      utterance.lang = pack.ttsCode || 'ja-JP';
      utterance.rate = 0.9;
      setIsSpeakingAll(true);
      utterance.onend = () => setIsSpeakingAll(false);
      utterance.onerror = () => setIsSpeakingAll(false);
      window.speechSynthesis.speak(utterance);
    }
  };

  // Font sizing classes with line-height about 2.2 for furigana headroom without extra gaps
  const fontClass =
    fontSize === 'sm'
      ? 'text-base leading-[2.2]'
      : fontSize === 'lg'
      ? 'text-2xl leading-[2.2]'
      : fontSize === 'xl'
      ? 'text-3xl leading-[2.3]'
      : 'text-xl leading-[2.2]';

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text)] flex flex-col pb-24 md:pb-12">
      {/* Top sticky reader control bar */}
      <header className="sticky top-0 z-30 bg-[var(--surface)]/90 backdrop-blur-md border-b border-[var(--border)] px-4 py-2.5">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => navigate('/library')}
              className="p-2 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              title="Return to Library"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h1 className="text-sm sm:text-base font-bold truncate max-w-xs sm:max-w-md">
                {activeDocument?.title || 'Reader'}
              </h1>
              <div className="text-[11px] text-slate-500 flex items-center gap-2">
                <span>{pack.nativeName}</span>
                <span>•</span>
                <span>{tokens.filter((t) => t.isWord).length} tokens</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2">
            {/* Furigana / Pinyin ruby toggle (shown only for languages supporting ruby annotations) */}
            {supportsRuby && (
              <button
                onClick={() => {
                  const next: FuriganaMode =
                    furiganaMode === 'always' ? 'hover' : furiganaMode === 'hover' ? 'never' : 'always';
                  setFuriganaMode(next);
                }}
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition ${
                  furiganaMode === 'always'
                    ? 'bg-indigo-50 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800'
                    : furiganaMode === 'hover'
                    ? 'bg-amber-50 dark:bg-amber-950/70 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-500 border-transparent'
                }`}
                title={pack.id === 'zh' ? 'Pinyin Display Mode' : 'Furigana Display Mode'}
              >
                <Eye className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{pack.id === 'zh' ? 'Pinyin:' : 'Furigana:'}</span>
                <span className="capitalize">{furiganaMode}</span>
              </button>
            )}

            {/* Font size toggle */}
            <button
              onClick={() => {
                const sizes: FontSize[] = ['sm', 'md', 'lg', 'xl'];
                const nextIdx = (sizes.indexOf(fontSize) + 1) % sizes.length;
                setFontSize(sizes[nextIdx]);
              }}
              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-bold transition flex items-center gap-1"
              title="Font Size"
            >
              <Type className="w-4 h-4" />
              <span className="uppercase text-[10px]">{fontSize}</span>
            </button>

            {/* Audio TTS */}
            <button
              onClick={handleSpeakText}
              className={`p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-semibold transition ${
                isSpeakingAll
                  ? 'bg-emerald-500 text-white'
                  : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
              title="Listen to text audio"
            >
              <Volume2 className="w-4 h-4" />
            </button>

            {/* Document Stats */}
            <button
              onClick={() => setShowStatsModal(true)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-sm transition"
              title="Document Comprehension Stats"
            >
              <PieChart className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Stats</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-4xl w-full mx-auto p-4 sm:p-8" onMouseUp={handleMouseUp}>
        {!activeDocument?.content ? (
          <div className="py-20 text-center space-y-4">
            <BookOpen className="w-12 h-12 text-slate-400 mx-auto" />
            <h3 className="text-lg font-bold">No document loaded</h3>
            <button
              onClick={() => navigate('/library')}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 transition"
            >
              Go to Library
            </button>
          </div>
        ) : (
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-6 sm:p-10 shadow-sm relative">
            {/* Status alerts: Kuromoji warning or background tokenizing */}
            <div className="mb-4 flex items-center justify-between gap-2 flex-wrap">
              {isTokenizing && (
                <div className="flex items-center gap-2 text-xs text-indigo-600 dark:text-indigo-400 font-semibold bg-indigo-50 dark:bg-indigo-950/60 px-3 py-1 rounded-full border border-indigo-200 dark:border-indigo-800">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Tokenizing with morphological engine...</span>
                </div>
              )}

              {activeLanguageId === 'ja' && getTokenizerWarning() && (
                <div className="flex items-center justify-between gap-2 text-xs text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/60 px-3.5 py-1.5 rounded-2xl border border-amber-200 dark:border-amber-800 w-full">
                  <div className="flex items-center gap-2 min-w-0">
                    <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span className="font-semibold">{getTokenizerWarning()}</span>
                  </div>
                  <button
                    onClick={() => navigate('/settings')}
                    className="text-[11px] underline font-bold shrink-0 hover:text-amber-900 dark:hover:text-amber-100"
                  >
                    View Diagnostics
                  </button>
                </div>
              )}
            </div>

            {/* Multi-word phrase selection helper floating bubble */}
            {selectedPhrase && (
              <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 bg-[var(--surface-elevated)] text-[var(--text)] px-4 py-2.5 rounded-full shadow-2xl flex items-center gap-2 sm:gap-3 animate-in fade-in slide-in-from-bottom-4 duration-200 border border-[var(--border)]">
                <span className="text-xs font-medium truncate max-w-[120px] sm:max-w-[200px]">
                  "{selectedPhrase}"
                </span>
                <button
                  onClick={handleCopyPhrase}
                  className="flex items-center gap-1 text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 px-3 py-1 rounded-full transition"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{copyToast ? 'Copied!' : 'Copy'}</span>
                </button>
                <button
                  onClick={handleAddPhraseCard}
                  className="flex items-center gap-1 text-xs font-bold bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 rounded-full transition shadow-xs"
                >
                  <BookmarkPlus className="w-3.5 h-3.5" />
                  <span>{phraseCardToast ? 'Added!' : 'Add to Cards'}</span>
                </button>
                <button
                  onClick={() => setSelectedPhrase('')}
                  className="p-1 text-slate-400 hover:text-[var(--text)] transition"
                  title="Clear selection"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Tokenized Text rendering: if tokens not yet available, show plain text */}
            <div className={`font-sans select-text ${fontClass}`}>
              {tokens.length === 0 ? (
                <div className="whitespace-pre-wrap leading-relaxed text-[var(--text)]">
                  {activeDocument.content}
                </div>
              ) : (
                tokens.map((token) => {
                if (token.isPunctuation) {
                  return (
                    <span key={token.id} className="text-slate-400 dark:text-slate-500">
                      {token.surface}
                    </span>
                  );
                }

                if (!token.isWord) {
                  return <span key={token.id}>{token.surface}</span>;
                }

                const lemmaOrSurface = token.baseForm || token.surface;
                const status: WordStatusType = wordStatuses[lemmaOrSurface] || wordStatuses[token.surface] || 'new';

                const isSelected = activeToken?.id === token.id;
                const tokenJlpt = wordJlptLevels[lemmaOrSurface] || wordJlptLevels[token.surface] || token.level;

                // JLPT Level Underline (Japanese only, when enabled via Settings)
                let jlptUnderlineStyle = '';
                if (activeLanguageId === 'ja' && jlptUnderlineEnabled && tokenJlpt) {
                  if (tokenJlpt === 'N5') {
                    jlptUnderlineStyle = 'underline decoration-emerald-500 decoration-2 underline-offset-4';
                  } else if (tokenJlpt === 'N4') {
                    jlptUnderlineStyle = 'underline decoration-sky-500 decoration-2 underline-offset-4';
                  } else if (tokenJlpt === 'N3') {
                    jlptUnderlineStyle = 'underline decoration-amber-500 decoration-2 underline-offset-4';
                  } else if (tokenJlpt === 'N2') {
                    jlptUnderlineStyle = 'underline decoration-orange-500 decoration-2 underline-offset-4';
                  } else if (tokenJlpt === 'N1') {
                    jlptUnderlineStyle = 'underline decoration-rose-500 decoration-2 underline-offset-4';
                  }
                }

                // Status highlighting (Known / Learning / Ignored / New)
                let statusStyle = '';
                if (jlptUnderlineStyle) {
                  if (status === 'learning') {
                    statusStyle = `${jlptUnderlineStyle} bg-[var(--reader-highlight-learning)] text-[var(--text)]`;
                  } else if (status === 'ignored') {
                    statusStyle = 'text-[var(--text-muted)] line-through';
                  } else {
                    statusStyle = `${jlptUnderlineStyle} text-[var(--text)]`;
                  }
                } else if (colorCodingEnabled) {
                  if (status === 'known') {
                    statusStyle = 'text-[var(--text)]';
                  } else if (status === 'learning') {
                    statusStyle =
                      'text-amber-800 dark:text-amber-300 underline decoration-amber-400/80 decoration-2 underline-offset-4 bg-[var(--reader-highlight-learning)]';
                  } else if (status === 'ignored') {
                    statusStyle = 'text-[var(--text-muted)] line-through';
                  } else {
                    statusStyle =
                      'text-indigo-900 dark:text-indigo-200 underline decoration-indigo-300 dark:decoration-indigo-700 decoration-1 underline-offset-4';
                  }
                }

                // Active token highlight (whole unit highlighted upon hover or selection)
                const highlightClass = isSelected
                  ? 'bg-indigo-100 dark:bg-indigo-950/90 ring-1 ring-indigo-500 dark:ring-indigo-400'
                  : 'hover:bg-[var(--reader-hover)]';

                const hasFurigana = token.furiganaSegments && token.furiganaSegments.length > 0;

                return (
                  <span
                    key={token.id}
                    data-token-id={token.id}
                    onMouseEnter={(e) => handleTokenMouseEnter(token, e)}
                    onMouseLeave={handleTokenMouseLeave}
                    onClick={(e) => handleTokenClick(token, e)}
                    className={`group/token cursor-pointer transition-colors duration-100 px-0.5 rounded ${statusStyle} ${highlightClass}`}
                  >
                    {hasFurigana ? (
                      <FuriganaText
                        segments={token.furiganaSegments}
                        furiganaMode={furiganaMode}
                        rtClassName="text-[var(--reader-ruby)] font-medium"
                      />
                    ) : (
                      <span>{token.surface}</span>
                    )}
                  </span>
                );
              }))}
            </div>
          </div>
        )}
      </main>

      {/* Floating Word Popup: anchors to token position, supports hover or pin */}
      {activeToken && popupPos && (
        <div
          style={{
            position: 'fixed',
            left: `${popupPos.x}px`,
            top: popupPos.showAbove ? undefined : `${popupPos.y}px`,
            bottom: popupPos.showAbove ? `${window.innerHeight - popupPos.y}px` : undefined,
            zIndex: 50,
          }}
          className="animate-in fade-in zoom-in-95 duration-100 max-w-[92vw]"
        >
          <WordPopup
            token={activeToken}
            entry={activeEntry}
            pack={pack}
            surroundingSentence={surroundingSentence}
            tokenSentenceRange={tokenSentenceRange}
            documentId={activeDocument?.id}
            documentTitle={activeDocument?.title}
            isPinned={isPinned}
            onClose={handleClosePopup}
            onMouseEnter={() => {
              if (closeTimerRef.current) {
                clearTimeout(closeTimerRef.current);
                closeTimerRef.current = null;
              }
              setIsHoveringPopup(true);
            }}
            onMouseLeave={() => {
              setIsHoveringPopup(false);
              if (!isPinned) {
                closeTimerRef.current = window.setTimeout(() => {
                  setActiveToken(null);
                  setActiveEntry(null);
                  setPopupPos(null);
                }, 180);
              }
            }}
            onStatusChange={() => {
              // Word status updated in store
            }}
          />
        </div>
      )}

      {/* Backdrop for pinned popup on mobile */}
      {isPinned && activeToken && (
        <div
          onClick={handleClosePopup}
          className="fixed inset-0 z-40 bg-black/20 sm:hidden backdrop-blur-xs"
        />
      )}

      {/* Comprehension Stats Modal */}
      {showStatsModal && (
        <TextStatsModal
          tokens={tokens}
          pack={pack}
          documentTitle={activeDocument?.title || 'Document'}
          onClose={() => setShowStatsModal(false)}
          onSelectWord={(token) => {
            const fullText = activeDocument?.content || '';
            const withOffsets = extractSentenceWithOffsets(
              fullText,
              token.startIndex,
              token.endIndex
            );
            setActiveToken(token);
            setSurroundingSentence(withOffsets?.sentence || '');
            setTokenSentenceRange(
              withOffsets
                ? { start: withOffsets.start, end: withOffsets.end, surface: token.surface }
                : null
            );
            setIsPinned(true);
            pack.lookup(token.surface, token.baseForm).then(setActiveEntry);
          }}
        />
      )}

    </div>
  );
};
