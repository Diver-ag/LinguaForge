import React, { useState, useEffect, useRef } from 'react';
import {
  db,
  type CardItem,
  type CardType,
  type ClozeData,
  type DeckItem,
  type ReviewLogItem,
} from '../../db/db';
import {
  addCardsForWord,
  findDuplicateClozeCard,
  updateCard,
  deleteCards,
  getDefaultDeckId,
} from '../../db/cards';
import { getLanguagePack } from '../../packs/registry';
import { buildFurigana } from '../../packs/japanese/kanaUtils';
import { RATING_LABELS, STATE_LABELS, formatIntervalText } from '../../core/fsrsScheduler';
import {
  formatClozeHint,
  resolveClozeFromSentence,
  validateClozeOffsets,
} from '../../core/cloze';
import { getStudySettings, DEFAULT_STUDY_SETTINGS, type ClozeHintMode } from '../../core/studySettings';
import { isSpeechSynthesisSupported } from '../../core/speech';
import { useAppStore } from '../../store/useAppStore';
import { ClozeSentenceView } from '../review/HighlightedSentence';
import type { Grade } from 'ts-fsrs';
import { X, Tag, Trash2, History, Loader2, Scissors, AlertTriangle, Eye, Headphones } from 'lucide-react';

export interface CardEditModalProps {
  card: CardItem | null;
  isCreating?: boolean;
  defaultCardType?: CardType;
  defaultDeckId?: string;
  decks: DeckItem[];
  languageId: string;
  onClose: () => void;
  onSaved: (updatedCard?: CardItem) => Promise<void> | void;
  onDeleted?: (deletedCardId: string) => Promise<void> | void;
}

interface EditFormState {
  word: string;
  lemma: string;
  reading: string;
  cardType: CardType;
  deckId: string;
  meaning: string;
  partOfSpeech: string;
  level: string;
  frequencyBand: string;
  sentence: string;
  sourceDocTitle: string;
  tags: string[];
  notes: string;
  suspended: boolean;
  buried: boolean;
  clozeStart: number;
  clozeEnd: number;
  clozeAnswer: string;
  clozeHint: string;
  listeningTarget: 'word' | 'sentence';
}

export const CardEditModal: React.FC<CardEditModalProps> = ({
  card,
  isCreating = false,
  defaultCardType = 'cloze',
  defaultDeckId,
  decks,
  languageId,
  onClose,
  onSaved,
  onDeleted,
}) => {
  const pack = getLanguagePack(languageId);
  const { furiganaMode } = useAppStore();
  const sentenceTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  const [selectionSpan, setSelectionSpan] = useState<{ start: number; end: number }>({
    start: 0,
    end: 0,
  });
  const [clozeHintMode, setClozeHintMode] = useState<ClozeHintMode>(
    DEFAULT_STUDY_SETTINGS.clozeHintMode
  );

  const [newTagInput, setNewTagInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reviewHistory, setReviewHistory] = useState<ReviewLogItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  useEffect(() => {
    getStudySettings()
      .then((s) => setClozeHintMode(s.clozeHintMode))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!card && !isCreating) {
      setEditForm(null);
      setReviewHistory([]);
      return;
    }

    if (isCreating && !card) {
      const initialDeckId = defaultDeckId || decks[0]?.id || getDefaultDeckId(languageId);
      setEditForm({
        word: '',
        lemma: '',
        reading: '',
        cardType: defaultCardType,
        deckId: initialDeckId,
        meaning: '',
        partOfSpeech: '',
        level: '',
        frequencyBand: '',
        sentence: '',
        sourceDocTitle: '',
        tags: [],
        notes: '',
        suspended: false,
        buried: false,
        clozeStart: 0,
        clozeEnd: 0,
        clozeAnswer: '',
        clozeHint: '',
        listeningTarget: 'word',
      });
      setSelectionSpan({ start: 0, end: 0 });
      setNewTagInput('');
      setConfirmDelete(false);
      setError(null);
      setReviewHistory([]);
      return;
    }

    if (!card) return;

    const existingCloze = card.cloze;
    let initStart = existingCloze?.start ?? 0;
    let initEnd = existingCloze?.end ?? 0;
    let initAnswer = existingCloze?.answer ?? card.word ?? '';
    let initHint = existingCloze?.hint ?? card.meaning ?? '';

    if (card.cardType === 'cloze' && !existingCloze && card.sentence) {
      const resolved = resolveClozeFromSentence({
        sentence: card.sentence,
        word: card.word,
        lemma: card.lemma,
        reading: card.reading,
        meaning: card.meaning,
      });
      if (resolved) {
        initStart = resolved.start;
        initEnd = resolved.end;
        initAnswer = resolved.answer;
        initHint = resolved.hint || card.meaning || '';
      }
    }

    setEditForm({
      word: card.word || '',
      lemma: card.lemma || '',
      reading: card.reading || '',
      cardType: card.cardType,
      deckId: card.deckId,
      meaning: card.meaning || '',
      partOfSpeech: card.partOfSpeech || '',
      level: card.level || '',
      frequencyBand: card.frequencyBand || '',
      sentence: existingCloze?.sentence || card.sentence || '',
      sourceDocTitle: card.sourceDocTitle || '',
      tags: [...(card.tags || [])],
      notes: card.notes || '',
      suspended: Boolean(card.suspended),
      buried: Boolean(card.buried),
      clozeStart: initStart,
      clozeEnd: initEnd,
      clozeAnswer: initAnswer,
      clozeHint: initHint,
      listeningTarget: card.listeningTarget === 'sentence' ? 'sentence' : 'word',
    });
    setSelectionSpan({ start: initStart, end: initEnd });
    setNewTagInput('');
    setConfirmDelete(false);
    setError(null);

    let cancelled = false;
    setIsLoadingHistory(true);
    db.reviewLogs
      .where('cardId')
      .equals(card.id)
      .toArray()
      .then((logs) => {
        if (cancelled) return;
        logs.sort((a, b) => b.reviewedAt - a.reviewedAt);
        setReviewHistory(logs);
      })
      .catch(() => {
        if (!cancelled) setReviewHistory([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingHistory(false);
      });

    return () => {
      cancelled = true;
    };
  }, [card, isCreating, defaultCardType, defaultDeckId, decks, languageId]);

  if ((!card && !isCreating) || !editForm) return null;

  const ttsSupported = isSpeechSynthesisSupported();
  const isCloze = editForm.cardType === 'cloze';
  const isListening = editForm.cardType === 'listening';
  const clozeValidation = validateClozeOffsets(
    editForm.sentence,
    editForm.clozeStart,
    editForm.clozeEnd,
    editForm.clozeAnswer
  );
  const hasSelectionInTextarea = selectionSpan.end > selectionSpan.start;

  const syncSelectionFromTextarea = () => {
    const el = sentenceTextareaRef.current;
    if (!el) return;
    setSelectionSpan({
      start: el.selectionStart ?? 0,
      end: el.selectionEnd ?? 0,
    });
  };

  const handleMarkSelectionAsBlank = () => {
    if (!editForm) return;
    const el = sentenceTextareaRef.current;
    const start = el ? el.selectionStart : selectionSpan.start;
    const end = el ? el.selectionEnd : selectionSpan.end;
    if (end <= start) return;

    const selectedSlice = editForm.sentence.slice(start, end);
    if (!selectedSlice.trim()) return;

    setError(null);
    setEditForm({
      ...editForm,
      clozeStart: start,
      clozeEnd: end,
      clozeAnswer: selectedSlice,
      word:
        !editForm.word.trim() || editForm.word === editForm.clozeAnswer
          ? selectedSlice
          : editForm.word,
      lemma: !editForm.lemma.trim() ? selectedSlice : editForm.lemma,
    });
  };

  const handleFindAnswerInSentence = () => {
    if (!editForm) return;
    const needle = (editForm.clozeAnswer || editForm.word).trim();
    if (!needle || !editForm.sentence) return;
    const idx = editForm.sentence.indexOf(needle);
    if (idx === -1) {
      setError(`Could not find "${needle}" in the sentence. Highlight text and click "Mark selection as blank".`);
      return;
    }
    setError(null);
    setEditForm({
      ...editForm,
      clozeStart: idx,
      clozeEnd: idx + needle.length,
      clozeAnswer: needle,
    });
  };

  const handleCardTypeChange = (nextType: CardType) => {
    if (!editForm) return;
    if (nextType === 'cloze') {
      const check = validateClozeOffsets(
        editForm.sentence,
        editForm.clozeStart,
        editForm.clozeEnd
      );
      if (!check.valid && editForm.sentence.trim()) {
        const resolved = resolveClozeFromSentence({
          sentence: editForm.sentence.trim(),
          word: editForm.word,
          lemma: editForm.lemma,
          reading: editForm.reading,
          meaning: editForm.meaning,
        });
        if (resolved) {
          setEditForm({
            ...editForm,
            cardType: nextType,
            clozeStart: resolved.start,
            clozeEnd: resolved.end,
            clozeAnswer: resolved.answer,
            clozeHint: editForm.clozeHint || resolved.hint || editForm.meaning,
          });
          return;
        }
      }
    }
    setEditForm({ ...editForm, cardType: nextType });
  };

  const handleAddTag = () => {
    const parts = newTagInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const merged = Array.from(new Set([...editForm.tags, ...parts]));
    setEditForm({ ...editForm, tags: merged });
    setNewTagInput('');
  };

  const handleRemoveTag = (tag: string) => {
    setEditForm({ ...editForm, tags: editForm.tags.filter((t) => t !== tag) });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    setIsSaving(true);
    setError(null);

    try {
      const rawSentence = editForm.sentence;
      const trimmedSentence = rawSentence.trim();
      const leadingTrim = rawSentence.length - rawSentence.trimStart().length;

      let nextCloze: ClozeData | undefined = undefined;
      let nextWord = editForm.word.trim();
      const nextReading = editForm.reading.trim();
      const nextLemma = editForm.lemma.trim() || nextWord || editForm.clozeAnswer.trim();

      if (editForm.cardType === 'cloze') {
        if (!trimmedSentence) {
          setError('Cloze cards require a sentence.');
          setIsSaving(false);
          return;
        }

        const adjustedStart = editForm.clozeStart - leadingTrim;
        const adjustedEnd = editForm.clozeEnd - leadingTrim;
        const validCheck = validateClozeOffsets(trimmedSentence, adjustedStart, adjustedEnd);

        if (!validCheck.valid) {
          setError(
            'Select the blank word or phrase inside the sentence and click "Mark selection as blank" before saving.'
          );
          setIsSaving(false);
          return;
        }

        const answerText = (editForm.clozeAnswer || validCheck.slice).trim() || validCheck.slice;
        if (validCheck.slice !== answerText) {
          setError(
            'The selected blank span does not match the sentence text anymore. Click "Mark selection as blank" or "Find in sentence" to update offsets.'
          );
          setIsSaving(false);
          return;
        }

        nextCloze = {
          sentence: trimmedSentence,
          start: adjustedStart,
          end: adjustedEnd,
          answer: answerText,
          lemma: nextLemma || answerText,
          reading: nextReading,
          hint: editForm.clozeHint.trim(),
        };

        if (!nextWord) nextWord = answerText;

        const duplicateCloze = await findDuplicateClozeCard({
          languageId,
          lemma: nextCloze.lemma,
          sentence: nextCloze.sentence,
          start: nextCloze.start,
          end: nextCloze.end,
          excludeCardId: card?.id,
        });
        if (duplicateCloze) {
          setError('An identical cloze card (same lemma, sentence, and blank) already exists.');
          setIsSaving(false);
          return;
        }
      } else if (!nextWord) {
        setError('Word is required.');
        setIsSaving(false);
        return;
      }

      let nextFurigana = card?.furiganaSegments;
      if (!card || nextWord !== card.word || nextReading !== card.reading) {
        nextFurigana = buildFurigana(nextWord, nextReading);
      }

      let nextSentenceFurigana = card?.sentenceFuriganaSegments;
      if (!card || trimmedSentence !== (card.sentence || '')) {
        if (!trimmedSentence) {
          nextSentenceFurigana = undefined;
        } else {
          try {
            const toks = await pack.tokenize(trimmedSentence);
            nextSentenceFurigana = toks.flatMap(
              (t) => t.furiganaSegments || [{ text: t.surface }]
            );
          } catch {
            nextSentenceFurigana = undefined;
          }
        }
      }

      if (isCreating && !card) {
        const { added } = await addCardsForWord({
          deckId: editForm.deckId,
          languageId,
          cardTypes: [editForm.cardType],
          word: nextWord,
          lemma: nextLemma || nextWord,
          reading: nextReading,
          furiganaSegments: nextFurigana,
          meaning: editForm.meaning.trim(),
          partOfSpeech: editForm.partOfSpeech.trim(),
          level: editForm.level.trim(),
          frequencyBand: editForm.frequencyBand.trim(),
          sentence: trimmedSentence,
          sentenceFuriganaSegments: nextSentenceFurigana,
          cloze: nextCloze,
          listeningTarget:
            editForm.cardType === 'listening' ? editForm.listeningTarget : undefined,
          sourceDocTitle: editForm.sourceDocTitle.trim(),
          tags: editForm.tags,
          notes: editForm.notes,
        });
        await onSaved(added[0]);
        onClose();
        return;
      }

      if (!card) return;

      const patch: Partial<CardItem> = {
        word: nextWord,
        lemma: nextLemma || nextWord,
        reading: nextReading,
        furiganaSegments: nextFurigana,
        cardType: editForm.cardType,
        deckId: editForm.deckId,
        meaning: editForm.meaning.trim(),
        partOfSpeech: editForm.partOfSpeech.trim(),
        level: editForm.level.trim(),
        frequencyBand: editForm.frequencyBand.trim(),
        sentence: trimmedSentence,
        sentenceFuriganaSegments: nextSentenceFurigana,
        cloze: editForm.cardType === 'cloze' ? nextCloze : undefined,
        listeningTarget:
          editForm.cardType === 'listening'
            ? editForm.listeningTarget === 'sentence' && trimmedSentence
              ? 'sentence'
              : 'word'
            : undefined,
        sourceDocTitle: editForm.sourceDocTitle.trim(),
        tags: editForm.tags,
        notes: editForm.notes,
        suspended: editForm.suspended,
        buried: editForm.buried,
        ...(editForm.buried ? {} : { buriedUntil: undefined }),
      };

      await updateCard(card.id, patch);
      const updated = (await db.cards.get(card.id)) || { ...card, ...patch };
      await onSaved(updated);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to save card changes.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!card) return;
    try {
      await deleteCards([card.id]);
      setConfirmDelete(false);
      await onDeleted?.(card.id);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete card.');
    }
  };

  const cardStateLabel = card ? STATE_LABELS[card.state ?? 0] || 'New' : 'New';
  const previewHintText = isCloze
    ? formatClozeHint(
        {
          cloze: clozeValidation.valid
            ? {
                sentence: editForm.sentence,
                start: editForm.clozeStart,
                end: editForm.clozeEnd,
                answer: editForm.clozeAnswer || clozeValidation.slice,
                lemma: editForm.lemma || editForm.word,
                reading: editForm.reading,
                hint: editForm.clozeHint,
              }
            : undefined,
          meaning: editForm.meaning,
          reading: editForm.reading,
        },
        clozeHintMode
      )
    : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-[var(--surface)] border border-[var(--border)] rounded-3xl shadow-2xl p-6 space-y-4"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
          <h3 className="text-base font-bold text-[var(--text)]">
            {isCreating && !card ? 'New Flashcard' : 'Edit Card'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
            aria-label="Close card editor"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-xs font-semibold text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <label className="space-y-1">
            <span className="font-semibold text-[var(--text-secondary)] block">Deck</span>
            <select
              value={editForm.deckId}
              onChange={(e) => setEditForm({ ...editForm, deckId: e.target.value })}
              className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
            >
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-[var(--text-secondary)] block">Card Type</span>
            <select
              value={editForm.cardType}
              onChange={(e) => handleCardTypeChange(e.target.value as CardType)}
              className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
            >
              <option value="word_to_meaning">Word → Meaning</option>
              <option value="meaning_to_word">Meaning → Word</option>
              <option value="reading">Reading</option>
              <option value="cloze">Cloze</option>
              {(ttsSupported || editForm.cardType === 'listening') && (
                <option value="listening">Listening</option>
              )}
            </select>
          </label>
        </div>

        {isListening && (
          <div className="p-3.5 rounded-2xl bg-[var(--surface-muted)]/70 border border-[var(--border)] space-y-2 text-xs">
            <div className="font-semibold text-[var(--text)] flex items-center gap-1.5">
              <Headphones className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>Listening audio speaks</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setEditForm({ ...editForm, listeningTarget: 'word' })}
                className={`min-h-[38px] px-3.5 py-1.5 rounded-xl border font-semibold transition ${
                  editForm.listeningTarget === 'word'
                    ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]'
                }`}
              >
                Word ({editForm.word || 'target'})
              </button>
              <button
                type="button"
                disabled={!editForm.sentence.trim()}
                onClick={() => setEditForm({ ...editForm, listeningTarget: 'sentence' })}
                className={`min-h-[38px] px-3.5 py-1.5 rounded-xl border font-semibold transition disabled:opacity-45 disabled:cursor-not-allowed ${
                  editForm.listeningTarget === 'sentence'
                    ? 'border-indigo-600 bg-[var(--accent-subtle)] text-[var(--accent-text)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]'
                }`}
              >
                Full sentence
              </button>
            </div>
            {!editForm.sentence.trim() && (
              <p className="text-[11px] text-[var(--text-muted)]">
                Add a context sentence below to enable full-sentence listening audio.
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <label className="space-y-1">
            <span className="font-semibold text-[var(--text-secondary)] block">
              {isCloze ? 'Word / Answer *' : 'Word *'}
            </span>
            <input
              type="text"
              required={!isCloze}
              value={editForm.word}
              onChange={(e) => setEditForm({ ...editForm, word: e.target.value })}
              className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
            />
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-[var(--text-secondary)] block">Lemma</span>
            <input
              type="text"
              value={editForm.lemma}
              onChange={(e) => setEditForm({ ...editForm, lemma: e.target.value })}
              className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
            />
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-[var(--text-secondary)] block">Reading</span>
            <input
              type="text"
              value={editForm.reading}
              onChange={(e) => setEditForm({ ...editForm, reading: e.target.value })}
              className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
            />
          </label>
        </div>

        <label className="block space-y-1 text-xs">
          <span className="font-semibold text-[var(--text-secondary)] block">Meaning *</span>
          <textarea
            rows={2}
            required
            value={editForm.meaning}
            onChange={(e) => setEditForm({ ...editForm, meaning: e.target.value })}
            className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
          />
        </label>

        {/* Sentence & Interactive Cloze Blank Selector */}
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-[var(--text-secondary)]">
              {isCloze ? 'Sentence * (highlight a word or phrase to mark as blank)' : 'Sentence'}
            </span>
            {isCloze && (
              <button
                type="button"
                disabled={!hasSelectionInTextarea}
                onClick={handleMarkSelectionAsBlank}
                className="min-h-[36px] px-3 py-1 rounded-xl border border-indigo-500/40 bg-indigo-500/10 hover:bg-indigo-500/20 disabled:opacity-45 disabled:cursor-not-allowed text-indigo-700 dark:text-indigo-300 font-bold inline-flex items-center gap-1.5 transition"
              >
                <Scissors className="w-3.5 h-3.5" />
                <span>Mark selection as blank</span>
              </button>
            )}
          </div>
          <textarea
            ref={sentenceTextareaRef}
            rows={2}
            required={isCloze}
            value={editForm.sentence}
            onSelect={syncSelectionFromTextarea}
            onMouseUp={syncSelectionFromTextarea}
            onKeyUp={syncSelectionFromTextarea}
            onChange={(e) => setEditForm({ ...editForm, sentence: e.target.value })}
            placeholder={
              isCloze
                ? 'Type or paste a sentence, then select any substring and click "Mark selection as blank".'
                : 'Optional example sentence...'
            }
            className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
          />

          {isCloze && (
            <div className="p-3.5 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)]/50 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="font-semibold text-[var(--text-secondary)] block">
                    Cloze blank answer
                  </span>
                  <input
                    type="text"
                    value={editForm.clozeAnswer}
                    onChange={(e) =>
                      setEditForm({ ...editForm, clozeAnswer: e.target.value })
                    }
                    placeholder="Blanked word or phrase"
                    className="w-full min-h-[38px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                  />
                </label>

                <label className="space-y-1">
                  <span className="font-semibold text-[var(--text-secondary)] block">
                    Blank hint (optional, overrides meaning)
                  </span>
                  <input
                    type="text"
                    value={editForm.clozeHint}
                    onChange={(e) => setEditForm({ ...editForm, clozeHint: e.target.value })}
                    placeholder={editForm.meaning || 'e.g. meaning or grammar cue'}
                    className="w-full min-h-[38px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                  />
                </label>
              </div>

              {(!clozeValidation.valid || clozeValidation.mismatch) && (
                <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex flex-wrap items-center justify-between gap-2 text-[11px] text-amber-800 dark:text-amber-300">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      {!clozeValidation.valid
                        ? 'No blank span marked yet. Highlight text in the sentence above and click "Mark selection as blank".'
                        : `Blank span (${editForm.clozeStart}–${editForm.clozeEnd}: "${clozeValidation.slice}") does not match answer "${editForm.clozeAnswer}".`}
                    </span>
                  </div>
                  {(editForm.clozeAnswer || editForm.word) && editForm.sentence && (
                    <button
                      type="button"
                      onClick={handleFindAnswerInSentence}
                      className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold shrink-0"
                    >
                      Find in sentence
                    </button>
                  )}
                </div>
              )}

              {/* Live Front + Back Cloze Preview */}
              {clozeValidation.valid && !clozeValidation.mismatch && (
                <div className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] space-y-2">
                  <div className="flex items-center justify-between text-[11px] font-bold text-[var(--text-muted)] uppercase tracking-wider">
                    <span className="inline-flex items-center gap-1">
                      <Eye className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                      <span>Live Cloze Preview</span>
                    </span>
                    <span className="font-mono normal-case tabular-nums">
                      Chars {editForm.clozeStart}–{editForm.clozeEnd}
                    </span>
                  </div>
                  <div className="text-sm text-[var(--text)] leading-relaxed">
                    <span className="text-[11px] font-semibold text-[var(--text-muted)] mr-1.5">
                      Front:
                    </span>
                    <ClozeSentenceView
                      sentence={editForm.sentence}
                      start={editForm.clozeStart}
                      end={editForm.clozeEnd}
                      mode="front"
                      furiganaMode={furiganaMode}
                    />
                    {previewHintText && (
                      <div className="text-[11px] text-[var(--text-muted)] mt-1">
                        Hint: {previewHintText}
                      </div>
                    )}
                  </div>
                  <div className="pt-1.5 border-t border-[var(--border)]/60 text-sm text-[var(--text)] leading-relaxed">
                    <span className="text-[11px] font-semibold text-[var(--text-muted)] mr-1.5">
                      Back:
                    </span>
                    <ClozeSentenceView
                      sentence={editForm.sentence}
                      start={editForm.clozeStart}
                      end={editForm.clozeEnd}
                      mode="back"
                      furiganaMode={furiganaMode}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <label className="space-y-1">
            <span className="font-semibold text-[var(--text-secondary)] block">Part of Speech</span>
            <input
              type="text"
              value={editForm.partOfSpeech}
              onChange={(e) => setEditForm({ ...editForm, partOfSpeech: e.target.value })}
              className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
            />
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-[var(--text-secondary)] block">Level</span>
            <input
              type="text"
              value={editForm.level}
              onChange={(e) => setEditForm({ ...editForm, level: e.target.value })}
              placeholder="e.g. N5, A2"
              className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
            />
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-[var(--text-secondary)] block">Frequency Band</span>
            <input
              type="text"
              value={editForm.frequencyBand}
              onChange={(e) => setEditForm({ ...editForm, frequencyBand: e.target.value })}
              placeholder="e.g. Top 6,000"
              className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
            />
          </label>
        </div>

        <label className="block space-y-1 text-xs">
          <span className="font-semibold text-[var(--text-secondary)] block">Source Text Title</span>
          <input
            type="text"
            value={editForm.sourceDocTitle}
            onChange={(e) => setEditForm({ ...editForm, sourceDocTitle: e.target.value })}
            className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
          />
        </label>

        {/* Tags editor */}
        <div className="space-y-2 text-xs">
          <span className="font-semibold text-[var(--text-secondary)] block">Tags</span>
          <div className="flex gap-2">
            <input
              type="text"
              value={newTagInput}
              onChange={(e) => setNewTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddTag();
                }
              }}
              placeholder="Add tag (comma-separated)..."
              className="flex-1 min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
            />
            <button
              type="button"
              onClick={handleAddTag}
              className="min-h-[40px] px-3.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--border)] font-semibold text-[var(--text)] inline-flex items-center gap-1"
            >
              <Tag className="w-3.5 h-3.5" />
              <span>Add</span>
            </button>
          </div>
          {editForm.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {editForm.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-xs text-[var(--text)]"
                >
                  <span>#{tag}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(tag)}
                    aria-label={`Remove tag ${tag}`}
                    className="text-[var(--text-muted)] hover:text-rose-600"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <label className="block space-y-1 text-xs">
          <span className="font-semibold text-[var(--text-secondary)] block">Notes</span>
          <textarea
            rows={2}
            value={editForm.notes}
            onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
            placeholder="Personal mnemonics or study notes..."
            className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
          />
        </label>

        {card && (
          <div className="flex items-center gap-5 pt-1 text-xs">
            <label className="inline-flex items-center gap-2 cursor-pointer font-medium text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={editForm.suspended}
                onChange={(e) => setEditForm({ ...editForm, suspended: e.target.checked })}
              />
              <span>Suspended</span>
            </label>

            <label className="inline-flex items-center gap-2 cursor-pointer font-medium text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={editForm.buried}
                onChange={(e) => setEditForm({ ...editForm, buried: e.target.checked })}
              />
              <span>Buried</span>
            </label>
          </div>
        )}

        {/* Per-Card Scheduling & Review History (only when editing existing card) */}
        {card && (
          <div className="pt-3 border-t border-[var(--border)] space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-bold text-[var(--text)] flex items-center gap-1.5">
                <History className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <span>Review History</span>
              </h4>
              <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
                {cardStateLabel} · Reps {card.reps ?? 0} · Lapses {card.lapses ?? 0}
                {(card.stability ?? 0) > 0 && ` · Stability ${(card.stability ?? 0).toFixed(1)}d`}
                {card.due && card.state !== 0 && ` · Due ${new Date(card.due).toLocaleDateString()}`}
              </div>
            </div>

            {isLoadingHistory ? (
              <div className="flex items-center gap-2 py-3 text-xs text-[var(--text-muted)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Loading history...</span>
              </div>
            ) : reviewHistory.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)] py-1">
                No reviews recorded for this card yet.
              </p>
            ) : (
              <div className="max-h-44 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50 divide-y divide-[var(--border)]">
                {reviewHistory.map((log) => {
                  const ratingLabel = RATING_LABELS[log.rating as Grade] || String(log.rating);
                  const prevLabel = STATE_LABELS[log.previousState ?? 0] || 'New';
                  const nextLabel = STATE_LABELS[log.state ?? 0] || 'New';
                  const intervalLabel = log.newDue
                    ? formatIntervalText(
                        new Date(log.newDue),
                        new Date(log.reviewedAt),
                        log.scheduledDays
                      )
                    : `${Math.round(log.scheduledDays)}d`;
                  const elapsedSec = (log.elapsed / 1000).toFixed(1);

                  return (
                    <div
                      key={log.id}
                      className="px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] tabular-nums"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-bold ${
                            log.rating === 1
                              ? 'text-rose-600 dark:text-rose-400'
                              : log.rating === 2
                              ? 'text-amber-600 dark:text-amber-400'
                              : log.rating === 3
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-sky-600 dark:text-sky-400'
                          }`}
                        >
                          {ratingLabel}
                        </span>
                        <span aria-hidden="true" className="text-[var(--text-muted)]">
                          ·
                        </span>
                        <span className="text-[var(--text-secondary)]">
                          {prevLabel} → {nextLabel}
                        </span>
                        <span aria-hidden="true" className="text-[var(--text-muted)]">
                          ·
                        </span>
                        <span className="text-[var(--text-muted)]">
                          Next {intervalLabel} · {elapsedSec}s
                        </span>
                        {log.isCustomStudy && (
                          <>
                            <span aria-hidden="true" className="text-[var(--text-muted)]">
                              ·
                            </span>
                            <span className="text-[var(--text-muted)]">Custom</span>
                          </>
                        )}
                      </div>
                      <span className="text-[var(--text-muted)]">
                        {new Date(log.reviewedAt).toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Inline delete confirmation or modal footer */}
        {confirmDelete && card ? (
          <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-rose-800 dark:text-rose-200">
              Permanently delete this card?
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="min-h-[36px] px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="min-h-[36px] px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold"
              >
                Confirm Delete
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[var(--border)]">
            {card ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-bold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition inline-flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Card</span>
              </button>
            ) : (
              <span />
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[42px] px-4 py-2 rounded-xl border border-[var(--border)] text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="min-h-[42px] px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-bold shadow-sm"
              >
                {isSaving ? 'Saving...' : isCreating && !card ? 'Create Card' : 'Save Changes'}
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
};
