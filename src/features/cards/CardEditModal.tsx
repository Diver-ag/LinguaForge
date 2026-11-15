import React, { useState, useEffect } from 'react';
import {
  db,
  type CardItem,
  type CardType,
  type DeckItem,
  type ReviewLogItem,
} from '../../db/db';
import { updateCard, deleteCards } from '../../db/cards';
import { getLanguagePack } from '../../packs/registry';
import { buildFurigana } from '../../packs/japanese/kanaUtils';
import { RATING_LABELS, STATE_LABELS, formatIntervalText } from '../../core/fsrsScheduler';
import type { Grade } from 'ts-fsrs';
import { X, Tag, Trash2, History, Loader2 } from 'lucide-react';

export interface CardEditModalProps {
  card: CardItem | null;
  decks: DeckItem[];
  languageId: string;
  onClose: () => void;
  onSaved: (updatedCard?: CardItem) => Promise<void> | void;
  onDeleted?: (deletedCardId: string) => Promise<void> | void;
}

export const CardEditModal: React.FC<CardEditModalProps> = ({
  card,
  decks,
  languageId,
  onClose,
  onSaved,
  onDeleted,
}) => {
  const pack = getLanguagePack(languageId);

  const [editForm, setEditForm] = useState<{
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
  } | null>(null);

  const [newTagInput, setNewTagInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reviewHistory, setReviewHistory] = useState<ReviewLogItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  useEffect(() => {
    if (!card) {
      setEditForm(null);
      setReviewHistory([]);
      return;
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
      sentence: card.sentence || '',
      sourceDocTitle: card.sourceDocTitle || '',
      tags: [...(card.tags || [])],
      notes: card.notes || '',
      suspended: Boolean(card.suspended),
      buried: Boolean(card.buried),
    });
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
  }, [card]);

  if (!card || !editForm) return null;

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
      const nextWord = editForm.word.trim();
      const nextReading = editForm.reading.trim();
      const nextSentence = editForm.sentence.trim();

      let nextFurigana = card.furiganaSegments;
      if (nextWord !== card.word || nextReading !== card.reading) {
        nextFurigana = buildFurigana(nextWord, nextReading);
      }

      let nextSentenceFurigana = card.sentenceFuriganaSegments;
      if (nextSentence !== (card.sentence || '')) {
        if (!nextSentence) {
          nextSentenceFurigana = undefined;
        } else {
          try {
            const toks = await pack.tokenize(nextSentence);
            nextSentenceFurigana = toks.flatMap(
              (t) => t.furiganaSegments || [{ text: t.surface }]
            );
          } catch {
            nextSentenceFurigana = undefined;
          }
        }
      }

      const patch: Partial<CardItem> = {
        word: nextWord,
        lemma: editForm.lemma.trim() || nextWord,
        reading: nextReading,
        furiganaSegments: nextFurigana,
        cardType: editForm.cardType,
        deckId: editForm.deckId,
        meaning: editForm.meaning.trim(),
        partOfSpeech: editForm.partOfSpeech.trim(),
        level: editForm.level.trim(),
        frequencyBand: editForm.frequencyBand.trim(),
        sentence: nextSentence,
        sentenceFuriganaSegments: nextSentenceFurigana,
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
    try {
      await deleteCards([card.id]);
      setConfirmDelete(false);
      await onDeleted?.(card.id);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete card.');
    }
  };

  const cardStateLabel = STATE_LABELS[card.state ?? 0] || 'New';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-[var(--surface)] border border-[var(--border)] rounded-3xl shadow-2xl p-6 space-y-4"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
          <h3 className="text-base font-bold text-[var(--text)]">Edit Card</h3>
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

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <label className="space-y-1">
            <span className="font-semibold text-[var(--text-secondary)] block">Word *</span>
            <input
              type="text"
              required
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
              onChange={(e) => setEditForm({ ...editForm, cardType: e.target.value as CardType })}
              className="w-full min-h-[40px] px-3 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
            >
              <option value="word_to_meaning">Word → Meaning</option>
              <option value="meaning_to_word">Meaning → Word</option>
              <option value="reading">Reading</option>
            </select>
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
          <span className="font-semibold text-[var(--text-secondary)] block">Sentence</span>
          <textarea
            rows={2}
            value={editForm.sentence}
            onChange={(e) => setEditForm({ ...editForm, sentence: e.target.value })}
            className="w-full px-3 py-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text)]"
          />
        </label>

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

        {/* Per-Card Scheduling & Review History */}
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

        {/* Inline delete confirmation or modal footer */}
        {confirmDelete ? (
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
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-bold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition inline-flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete Card</span>
            </button>

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
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
};
