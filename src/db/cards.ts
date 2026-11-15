import { db, type CardItem, type CardType, type DeckItem } from './db';
import { getAllLanguagePacks } from '../packs/registry';

export function generateEntityId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function getDefaultDeckId(languageId: string): string {
  return `default-${languageId}`;
}

export async function ensureDefaultDeck(languageId: string): Promise<DeckItem> {
  const defaultId = getDefaultDeckId(languageId);
  const existing = await db.decks.get(defaultId);
  if (existing) return existing;

  // Check if any deck already exists for this language
  const anyForLang = await db.decks.where('languageId').equals(languageId).first();
  if (anyForLang) return anyForLang;

  const deck: DeckItem = {
    id: defaultId,
    name: 'Default',
    languageId,
    createdAt: Date.now(),
    description: 'Default vocabulary deck',
  };
  await db.decks.put(deck);
  return deck;
}

export async function ensureAllDefaultDecks(): Promise<void> {
  const packs = getAllLanguagePacks();
  for (const p of packs) {
    await ensureDefaultDeck(p.id);
  }
}

export interface DeckWithCount extends DeckItem {
  cardCount: number;
  suspendedCount: number;
}

export async function getDecksWithCounts(languageId: string): Promise<DeckWithCount[]> {
  await ensureDefaultDeck(languageId);
  const [decks, cards] = await Promise.all([
    db.decks.where('languageId').equals(languageId).toArray(),
    db.cards.where('languageId').equals(languageId).toArray(),
  ]);

  const countMap = new Map<string, { total: number; suspended: number }>();
  for (const card of cards) {
    const cur = countMap.get(card.deckId) || { total: 0, suspended: 0 };
    cur.total += 1;
    if (card.suspended) cur.suspended += 1;
    countMap.set(card.deckId, cur);
  }

  decks.sort((a, b) => {
    const aIsDefault = a.id === getDefaultDeckId(languageId) ? 0 : 1;
    const bIsDefault = b.id === getDefaultDeckId(languageId) ? 0 : 1;
    if (aIsDefault !== bIsDefault) return aIsDefault - bIsDefault;
    return a.createdAt - b.createdAt;
  });

  return decks.map((d) => {
    const stats = countMap.get(d.id) || { total: 0, suspended: 0 };
    return {
      ...d,
      cardCount: stats.total,
      suspendedCount: stats.suspended,
    };
  });
}

export async function createDeck(params: {
  languageId: string;
  name: string;
  description?: string;
}): Promise<DeckItem> {
  const trimmedName = params.name.trim();
  if (!trimmedName) {
    throw new Error('Deck name cannot be empty.');
  }

  const deck: DeckItem = {
    id: generateEntityId('deck'),
    name: trimmedName,
    languageId: params.languageId,
    createdAt: Date.now(),
    description: params.description?.trim() || '',
  };
  await db.decks.put(deck);
  return deck;
}

export async function renameDeck(
  deckId: string,
  name: string,
  description?: string
): Promise<void> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Deck name cannot be empty.');
  }
  const updates: Partial<DeckItem> = { name: trimmedName };
  if (description !== undefined) {
    updates.description = description.trim();
  }
  await db.decks.update(deckId, updates);
}

export async function deleteDeck(
  deckId: string,
  resolution: { mode: 'move'; targetDeckId: string } | { mode: 'delete' }
): Promise<void> {
  const deck = await db.decks.get(deckId);
  if (!deck) return;

  const langDecks = await db.decks.where('languageId').equals(deck.languageId).toArray();
  if (langDecks.length <= 1) {
    throw new Error('Cannot delete the only deck for this language.');
  }

  await db.transaction('rw', [db.decks, db.cards], async () => {
    const deckCards = await db.cards.where('deckId').equals(deckId).toArray();
    if (deckCards.length > 0) {
      if (resolution.mode === 'move') {
        const now = Date.now();
        const moved = deckCards.map((c) => ({
          ...c,
          deckId: resolution.targetDeckId,
          updatedAt: now,
        }));
        await db.cards.bulkPut(moved);
      } else {
        await db.cards.bulkDelete(deckCards.map((c) => c.id));
      }
    }
    await db.decks.delete(deckId);
  });
}

export async function findDuplicateCard(params: {
  languageId: string;
  lemma: string;
  reading: string;
  cardType: CardType;
}): Promise<CardItem | undefined> {
  const matches = await db.cards
    .where('[lemma+reading+cardType]')
    .equals([params.lemma, params.reading, params.cardType])
    .toArray();
  return matches.find((c) => c.languageId === params.languageId);
}

export async function addCardsForWord(params: {
  deckId?: string;
  languageId: string;
  cardTypes: CardType[];
  word: string;
  lemma: string;
  reading: string;
  furiganaSegments?: { text: string; ruby?: string }[];
  meaning: string;
  partOfSpeech?: string;
  level?: string;
  frequencyBand?: string;
  sentence?: string;
  sentenceFuriganaSegments?: { text: string; ruby?: string }[];
  sourceDocTitle?: string;
  sourceDocId?: number;
  tags?: string[];
  notes?: string;
}): Promise<{ added: CardItem[]; duplicateTypes: CardType[] }> {
  const defaultDeck = await ensureDefaultDeck(params.languageId);
  const targetDeckId = params.deckId || defaultDeck.id;
  const now = Date.now();
  const normalizedLemma = (params.lemma || params.word).trim();
  const normalizedReading = (params.reading || '').trim();
  const requestedTypes: CardType[] =
    params.cardTypes.length > 0 ? params.cardTypes : ['word_to_meaning'];

  const added: CardItem[] = [];
  const duplicateTypes: CardType[] = [];

  for (const cardType of requestedTypes) {
    const existing = await findDuplicateCard({
      languageId: params.languageId,
      lemma: normalizedLemma,
      reading: normalizedReading,
      cardType,
    });

    if (existing) {
      duplicateTypes.push(cardType);
      continue;
    }

    const newCard: CardItem = {
      id: generateEntityId('card'),
      deckId: targetDeckId,
      languageId: params.languageId,
      cardType,
      word: params.word,
      lemma: normalizedLemma,
      reading: normalizedReading,
      furiganaSegments: params.furiganaSegments,
      meaning: params.meaning,
      partOfSpeech: params.partOfSpeech || '',
      level: params.level || '',
      frequencyBand: params.frequencyBand || '',
      sentence: params.sentence || '',
      sentenceFuriganaSegments: params.sentenceFuriganaSegments,
      sourceDocTitle: params.sourceDocTitle || '',
      sourceDocId: params.sourceDocId,
      tags: params.tags || [],
      notes: params.notes || '',
      createdAt: now,
      updatedAt: now,
      suspended: false,
      buried: false,
    };

    await db.cards.put(newCard);
    added.push(newCard);
  }

  return { added, duplicateTypes };
}

export async function updateCard(id: string, patch: Partial<CardItem>): Promise<void> {
  await db.cards.update(id, {
    ...patch,
    updatedAt: Date.now(),
  });
}

export async function deleteCards(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.cards.bulkDelete(ids);
}

export async function bulkMoveCards(ids: string[], targetDeckId: string): Promise<void> {
  if (ids.length === 0) return;
  const cards = (await db.cards.bulkGet(ids)).filter(Boolean) as CardItem[];
  const now = Date.now();
  await db.cards.bulkPut(cards.map((c) => ({ ...c, deckId: targetDeckId, updatedAt: now })));
}

export async function bulkTagCards(
  ids: string[],
  action: 'add' | 'remove',
  tagInput: string
): Promise<void> {
  const cleanTags = tagInput
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (ids.length === 0 || cleanTags.length === 0) return;

  const cards = (await db.cards.bulkGet(ids)).filter(Boolean) as CardItem[];
  const now = Date.now();

  const updated = cards.map((card) => {
    const current = new Set(card.tags || []);
    if (action === 'add') {
      for (const t of cleanTags) current.add(t);
    } else {
      for (const t of cleanTags) current.delete(t);
    }
    return {
      ...card,
      tags: Array.from(current),
      updatedAt: now,
    };
  });

  await db.cards.bulkPut(updated);
}
