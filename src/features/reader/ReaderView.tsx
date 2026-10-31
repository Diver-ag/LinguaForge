import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DictionaryEntry, LanguagePack, Token } from '../../core/languagePack';
import { db, type WordStatusType } from '../../db/db';
import { getLanguagePack } from '../../packs/registry';
import { useAppStore, type FuriganaMode, type FontSize } from '../../store/useAppStore';
import { translateAndExplainPhrase, type PhraseTranslationResult } from '../../ai/gemini';
import { getTokenizerWarning } from '../../packs/japanese/tokenizer';
import { WordPopup } from './WordPopup';
import { TextStatsModal } from './TextStatsModal';
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
} from 'lucide-react';

export const ReaderView: React.FC = () => {
  const navigate = useNavigate();
  const {
    activeLanguageId,
    activeDocument,
    wordStatuses,
    furiganaMode,
    colorCodingEnabled,
    fontSize,
    setFuriganaMode,
    setFontSize,
    recordLookup,
    setActiveDocument,
  } = useAppStore();

  const pack = useMemo(() => getLanguagePack(activeLanguageId), [activeLanguageId]);

  // Loading & token states
  const [tokens, setTokens] = useState<Token[]>([]);
  const [isTokenizing, setIsTokenizing] = useState(false);

  // Popup & active token state
  const [activeToken, setActiveToken] = useState<Token | null>(null);
  const [activeEntry, setActiveEntry] = useState<DictionaryEntry | null>(null);
  const [surroundingSentence, setSurroundingSentence] = useState<string>('');
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
  const [phraseTranslation, setPhraseTranslation] = useState<PhraseTranslationResult | null>(null);
  const [isTranslatingPhrase, setIsTranslatingPhrase] = useState(false);
  const [phraseError, setPhraseError] = useState<{ message: string; isModelNotFound?: boolean } | null>(null);
  const [showPhraseModal, setShowPhraseModal] = useState(false);

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
      const sentence = extractSurroundingSentence(activeDocument?.content || '', token.startIndex);

      setActiveToken(token);
      setActiveEntry(entry);
      setSurroundingSentence(sentence);
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
    const sentence = extractSurroundingSentence(activeDocument?.content || '', token.startIndex);

    setActiveToken(token);
    setActiveEntry(entry);
    setSurroundingSentence(sentence);
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

  const handleTranslatePhrase = async () => {
    if (!selectedPhrase) return;
    setIsTranslatingPhrase(true);
    setPhraseError(null);
    setShowPhraseModal(true);

    try {
      const res = await translateAndExplainPhrase(selectedPhrase, selectionContextSentence, pack.name);
      setPhraseTranslation(res);
      setIsTranslatingPhrase(false);
    } catch (err: any) {
      setIsTranslatingPhrase(false);
      const isNotFound =
        err?.isModelNotFound ||
        err?.statusCode === 404 ||
        err?.message === 'This model is unavailable. Pick another one in Settings' ||
        /not found/i.test(err?.message || '') ||
        /is no longer available/i.test(err?.message || '');

      if (err?.message === 'NO_API_KEY') {
        setPhraseError({
          message: 'Gemini API key is not configured. Add your key in Settings to unlock AI phrase explanations.',
          isModelNotFound: true,
        });
      } else if (err?.message === 'OFFLINE') {
        setPhraseError({
          message: 'You are currently offline. AI phrase analysis requires an active internet connection.',
          isModelNotFound: false,
        });
      } else if (isNotFound) {
        setPhraseError({
          message: 'This model is unavailable. Pick another one in Settings',
          isModelNotFound: true,
        });
      } else {
        setPhraseError({
          message: err?.message || 'Could not reach AI service',
          isModelNotFound: false,
        });
      }
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

  // Font sizing classes
  const fontClass =
    fontSize === 'sm'
      ? 'text-base leading-relaxed'
      : fontSize === 'lg'
      ? 'text-2xl leading-loose'
      : fontSize === 'xl'
      ? 'text-3xl leading-[2.6]'
      : 'text-xl leading-[2.2]';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col pb-24 md:pb-12">
      {/* Top sticky reader control bar */}
      <header className="sticky top-0 z-30 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 py-2.5">
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
            {/* Furigana toggle */}
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
              title="Furigana Display Mode"
            >
              <Eye className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Furigana:</span>
              <span className="capitalize">{furiganaMode}</span>
            </button>

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
          <div className="bg-white dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800/80 rounded-3xl p-6 sm:p-10 shadow-sm relative">
            {/* Status alerts: Kuromoji warning or background tokenizing */}
            <div className="mb-4 flex items-center justify-between gap-2 flex-wrap">
              {isTokenizing && (
                <div className="flex items-center gap-2 text-xs text-indigo-600 dark:text-indigo-400 font-semibold bg-indigo-50 dark:bg-indigo-950/60 px-3 py-1 rounded-full border border-indigo-200 dark:border-indigo-800">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Tokenizing with morphological engine...</span>
                </div>
              )}

              {getTokenizerWarning() && (
                <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300 font-semibold bg-amber-50 dark:bg-amber-950/60 px-3 py-1 rounded-full border border-amber-200 dark:border-amber-800">
                  <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span>{getTokenizerWarning()}</span>
                </div>
              )}
            </div>

            {/* Multi-word phrase selection helper floating bubble */}
            {selectedPhrase && !showPhraseModal && (
              <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 bg-slate-900 text-white dark:bg-white dark:text-slate-900 px-4 py-2.5 rounded-full shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4 duration-200">
                <span className="text-xs font-medium truncate max-w-[150px]">"{selectedPhrase}"</span>
                <button
                  onClick={handleTranslatePhrase}
                  className="flex items-center gap-1 text-xs font-bold bg-indigo-600 text-white dark:bg-indigo-600 px-3 py-1 rounded-full hover:bg-indigo-700 transition"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Translate Phrase
                </button>
                <button
                  onClick={() => setSelectedPhrase('')}
                  className="p-1 text-slate-400 hover:text-white dark:hover:text-black transition"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Tokenized Text rendering: if tokens not yet available, show plain text */}
            <div className={`font-sans tracking-wide select-text ${fontClass}`}>
              {tokens.length === 0 ? (
                <div className="whitespace-pre-wrap leading-relaxed text-slate-800 dark:text-slate-200">
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

                // Status highlighting
                let statusStyle = '';
                if (colorCodingEnabled) {
                  if (status === 'known') {
                    statusStyle = 'text-slate-800 dark:text-slate-200';
                  } else if (status === 'learning') {
                    statusStyle =
                      'text-amber-800 dark:text-amber-300 underline decoration-amber-400/80 decoration-2 underline-offset-4 bg-amber-50/50 dark:bg-amber-950/30';
                  } else if (status === 'ignored') {
                    statusStyle = 'text-slate-400 line-through';
                  } else {
                    statusStyle =
                      'text-indigo-900 dark:text-indigo-200 underline decoration-indigo-300 dark:decoration-indigo-700 decoration-1 underline-offset-4';
                  }
                }

                // Active token highlight (whole unit highlighted upon hover or selection)
                const highlightClass = isSelected
                  ? 'bg-indigo-100 dark:bg-indigo-950/90 ring-2 ring-indigo-500 dark:ring-indigo-400 rounded-sm'
                  : 'hover:bg-indigo-50/80 dark:hover:bg-indigo-950/40 rounded-sm';

                const hasFurigana = token.furiganaSegments && token.furiganaSegments.length > 0;

                return (
                  <span
                    key={token.id}
                    data-token-id={token.id}
                    onMouseEnter={(e) => handleTokenMouseEnter(token, e)}
                    onMouseLeave={handleTokenMouseLeave}
                    onClick={(e) => handleTokenClick(token, e)}
                    className={`inline-block cursor-pointer transition-colors duration-100 px-0.5 ${statusStyle} ${highlightClass}`}
                  >
                    {hasFurigana ? (
                      <ruby className="group/ruby pointer-events-none">
                        {token.furiganaSegments!.map((seg, idx) => (
                          <React.Fragment key={idx}>
                            {seg.text}
                            {seg.ruby && (
                              <rt
                                className={`text-[0.55em] font-medium tracking-normal text-slate-500 dark:text-slate-400 select-none ${
                                  furiganaMode === 'always'
                                    ? 'opacity-100'
                                    : furiganaMode === 'hover'
                                    ? 'opacity-0 group-hover/ruby:opacity-100 transition-opacity'
                                    : 'opacity-0 hidden'
                                }`}
                              >
                                {seg.ruby}
                              </rt>
                            )}
                          </React.Fragment>
                        ))}
                      </ruby>
                    ) : (
                      token.surface
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
            setActiveToken(token);
            setIsPinned(true);
            pack.lookup(token.surface, token.baseForm).then(setActiveEntry);
          }}
        />
      )}

      {/* AI Phrase Translation Modal */}
      {showPhraseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <h3 className="font-bold text-slate-900 dark:text-white text-base">Phrase Translation & Nuance</h3>
              </div>
              <button
                onClick={() => {
                  setShowPhraseModal(false);
                  setSelectedPhrase('');
                }}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {isTranslatingPhrase ? (
              <div className="py-12 flex flex-col items-center justify-center space-y-3">
                <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
                <p className="text-sm font-medium text-slate-500">Analyzing phrase context with Gemini...</p>
              </div>
            ) : phraseError ? (
              <div className="p-4 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-xl space-y-3">
                <div className="flex items-start gap-2.5 text-amber-800 dark:text-amber-300 text-sm">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <p className="font-medium leading-relaxed">{phraseError.message}</p>
                </div>
                {(phraseError.isModelNotFound || phraseError.message.includes('Settings')) && (
                  <button
                    onClick={() => {
                      setShowPhraseModal(false);
                      navigate('/settings');
                    }}
                    className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-sm active:scale-95"
                  >
                    <Settings className="w-3.5 h-3.5" />
                    Open Settings
                  </button>
                )}
              </div>
            ) : phraseTranslation ? (
              <div className="space-y-4 text-sm">
                <div className="p-3 bg-indigo-50/60 dark:bg-indigo-950/40 rounded-xl border border-indigo-100 dark:border-indigo-900/40">
                  <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 block mb-0.5">
                    Selected Phrase
                  </span>
                  <div className="text-xl font-bold text-slate-900 dark:text-white">
                    {phraseTranslation.phrase}
                  </div>
                </div>

                <div className="space-y-1">
                  <span className="text-xs font-semibold text-slate-400">Natural Translation</span>
                  <p className="font-semibold text-base text-slate-900 dark:text-white">
                    {phraseTranslation.naturalTranslation}
                  </p>
                </div>

                {phraseTranslation.literalTranslation && (
                  <div className="space-y-1">
                    <span className="text-xs font-semibold text-slate-400">Literal Meaning</span>
                    <p className="text-slate-600 dark:text-slate-300 text-xs">
                      {phraseTranslation.literalTranslation}
                    </p>
                  </div>
                )}

                {phraseTranslation.nuanceExplanation && (
                  <div className="p-3 bg-slate-50 dark:bg-slate-800/60 rounded-xl text-xs space-y-1">
                    <span className="font-bold text-slate-700 dark:text-slate-200 block">Nuance & Grammar</span>
                    <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                      {phraseTranslation.nuanceExplanation}
                    </p>
                  </div>
                )}

                {phraseTranslation.breakdown && phraseTranslation.breakdown.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-slate-400">Component Breakdown</span>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {phraseTranslation.breakdown.map((item, idx) => (
                        <div
                          key={idx}
                          className="p-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                        >
                          <span className="font-bold text-indigo-600 dark:text-indigo-400 block">
                            {item.component}
                          </span>
                          <span className="text-slate-500 dark:text-slate-400">{item.meaning}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            <div className="flex justify-end pt-2">
              <button
                onClick={() => {
                  setShowPhraseModal(false);
                  setSelectedPhrase('');
                }}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs font-semibold rounded-xl transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
