import { db, type CardItem, type CardType, type ClozeData, type DeckItem } from './db';
import { getAllLanguagePacks } from '../packs/registry';
import { invalidateStatsCache } from '../core/statsCache';
import {
  buildClozeDuplicateKey,
  getEffectiveClozeData,
  resolveClozeFromSentence,
  validateClozeOffsets,
  type ClozeTokenCandidate,
} from '../core/cloze';

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

export async function findDuplicateClozeCard(params: {
  languageId: string;
  lemma: string;
  sentence: string;
  start: number;
  end: number;
  excludeCardId?: string;
}): Promise<CardItem | undefined> {
  const targetKey = buildClozeDuplicateKey(params);
  const candidates = await db.cards
    .where('languageId')
    .equals(params.languageId)
    .filter((c) => c.cardType === 'cloze' && c.id !== params.excludeCardId)
    .toArray();

  return candidates.find((c) => {
    const cloze = getEffectiveClozeData(c);
    if (!cloze) return false;
    const key = buildClozeDuplicateKey({
      languageId: c.languageId,
      lemma: cloze.lemma || c.lemma || c.word,
      sentence: cloze.sentence,
      start: cloze.start,
      end: cloze.end,
    });
    return key === targetKey;
  });
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
  cloze?: ClozeData;
  listeningTarget?: 'word' | 'sentence';
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
    let clozePayload: ClozeData | undefined;

    if (cardType === 'cloze') {
      const candidateSentence = (params.cloze?.sentence ?? params.sentence ?? '').trim();
      if (!candidateSentence) {
        continue;
      }
      if (params.cloze) {
        const check = validateClozeOffsets(
          candidateSentence,
          params.cloze.start,
          params.cloze.end
        );
        if (!check.valid) continue;
        clozePayload = {
          sentence: candidateSentence,
          start: params.cloze.start,
          end: params.cloze.end,
          answer: params.cloze.answer || check.slice || params.word,
          lemma: (params.cloze.lemma || normalizedLemma).trim(),
          reading: (params.cloze.reading ?? normalizedReading).trim(),
          hint: params.cloze.hint !== undefined ? params.cloze.hint : params.meaning,
        };
      } else {
        const resolved = resolveClozeFromSentence({
          sentence: candidateSentence,
          word: params.word,
          lemma: normalizedLemma,
          reading: normalizedReading,
          meaning: params.meaning,
        });
        if (!resolved) continue;
        clozePayload = resolved;
      }

      const existingCloze = await findDuplicateClozeCard({
        languageId: params.languageId,
        lemma: clozePayload.lemma,
        sentence: clozePayload.sentence,
        start: clozePayload.start,
        end: clozePayload.end,
      });
      if (existingCloze) {
        duplicateTypes.push('cloze');
        continue;
      }
    } else {
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
    }

    const newCard: CardItem = {
      id: generateEntityId('card'),
      deckId: targetDeckId,
      languageId: params.languageId,
      cardType,
      word: cardType === 'cloze' && clozePayload ? clozePayload.answer : params.word,
      lemma: cardType === 'cloze' && clozePayload ? clozePayload.lemma : normalizedLemma,
      reading: cardType === 'cloze' && clozePayload ? clozePayload.reading : normalizedReading,
      furiganaSegments: params.furiganaSegments,
      meaning: params.meaning,
      partOfSpeech: params.partOfSpeech || '',
      level: params.level || '',
      frequencyBand: params.frequencyBand || '',
      sentence: clozePayload ? clozePayload.sentence : params.sentence || '',
      sentenceFuriganaSegments: params.sentenceFuriganaSegments,
      cloze: clozePayload,
      listeningTarget:
        cardType === 'listening'
          ? params.listeningTarget === 'sentence' && (params.sentence || '').trim()
            ? 'sentence'
            : 'word'
          : undefined,
      sourceDocTitle: params.sourceDocTitle || '',
      sourceDocId: params.sourceDocId,
      tags: params.tags || [],
      notes: params.notes || '',
      createdAt: now,
      updatedAt: now,
      suspended: false,
      buried: false,
      due: now,
      stability: 0,
      difficulty: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      scheduledDays: 0,
      elapsedDays: 0,
      learningSteps: 0,
    };

    await db.cards.put(newCard);
    added.push(newCard);
  }
  if (added.length > 0) invalidateStatsCache();

  return { added, duplicateTypes };
}

export async function createClozeCardsFromCards(
  cardIds: string[],
  tokenizeSentence?: (
    sentence: string,
    languageId: string
  ) => Promise<ClozeTokenCandidate[]>
): Promise<{
  created: CardItem[];
  skippedDuplicate: number;
  skippedNoSentence: number;
  skippedNoMatch: number;
}> {
  if (cardIds.length === 0) {
    return { created: [], skippedDuplicate: 0, skippedNoSentence: 0, skippedNoMatch: 0 };
  }

  const cards = (await db.cards.bulkGet(cardIds)).filter(Boolean) as CardItem[];
  const now = Date.now();
  const created: CardItem[] = [];
  let skippedDuplicate = 0;
  let skippedNoSentence = 0;
  let skippedNoMatch = 0;

  // Track existing cloze keys per language + any created in this batch
  const existingClozeKeysByLang = new Map<string, Set<string>>();
  const getLangKeys = async (langId: string) => {
    let set = existingClozeKeysByLang.get(langId);
    if (set) return set;
    const existingClozes = await db.cards
      .where('languageId')
      .equals(langId)
      .filter((c) => c.cardType === 'cloze')
      .toArray();
    set = new Set<string>();
    for (const c of existingClozes) {
      const cl = getEffectiveClozeData(c);
      if (!cl) continue;
      set.add(
        buildClozeDuplicateKey({
          languageId: langId,
          lemma: cl.lemma || c.lemma || c.word,
          sentence: cl.sentence,
          start: cl.start,
          end: cl.end,
        })
      );
    }
    existingClozeKeysByLang.set(langId, set);
    return set;
  };

  for (const src of cards) {
    const sentence = (src.cloze?.sentence || src.sentence || '').trim();
    if (!sentence) {
      skippedNoSentence++;
      continue;
    }

    let clozeData: ClozeData | null = null;
    if (src.cardType === 'cloze' && src.cloze) {
      const valid = validateClozeOffsets(sentence, src.cloze.start, src.cloze.end);
      if (valid.valid) {
        clozeData = {
          sentence,
          start: src.cloze.start,
          end: src.cloze.end,
          answer: src.cloze.answer || valid.slice,
          lemma: src.cloze.lemma || src.lemma || src.word,
          reading: src.cloze.reading ?? src.reading ?? '',
          hint: src.cloze.hint !== undefined ? src.cloze.hint : src.meaning,
        };
      }
    }

    if (!clozeData) {
      let tokens: ClozeTokenCandidate[] | undefined;
      if (tokenizeSentence) {
        try {
          tokens = await tokenizeSentence(sentence, src.languageId);
        } catch {
          tokens = undefined;
        }
      }
      clozeData = resolveClozeFromSentence({
        sentence,
        word: src.word,
        lemma: src.lemma || src.word,
        reading: src.reading,
        meaning: src.meaning,
        tokens,
      });
    }

    if (!clozeData) {
      skippedNoMatch++;
      continue;
    }

    const langKeys = await getLangKeys(src.languageId);
    const dupKey = buildClozeDuplicateKey({
      languageId: src.languageId,
      lemma: clozeData.lemma,
      sentence: clozeData.sentence,
      start: clozeData.start,
      end: clozeData.end,
    });

    if (langKeys.has(dupKey)) {
      skippedDuplicate++;
      continue;
    }

    langKeys.add(dupKey);
    const newCard: CardItem = {
      id: generateEntityId('card'),
      deckId: src.deckId,
      languageId: src.languageId,
      cardType: 'cloze',
      word: clozeData.answer,
      lemma: clozeData.lemma,
      reading: clozeData.reading,
      furiganaSegments: src.furiganaSegments,
      meaning: src.meaning,
      partOfSpeech: src.partOfSpeech || '',
      level: src.level || '',
      frequencyBand: src.frequencyBand || '',
      sentence: clozeData.sentence,
      sentenceFuriganaSegments: src.sentenceFuriganaSegments,
      cloze: clozeData,
      sourceDocTitle: src.sourceDocTitle || '',
      sourceDocId: src.sourceDocId,
      tags: Array.isArray(src.tags) ? [...src.tags] : [],
      notes: src.notes || '',
      createdAt: now,
      updatedAt: now,
      suspended: false,
      buried: false,
      due: now,
      stability: 0,
      difficulty: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      scheduledDays: 0,
      elapsedDays: 0,
      learningSteps: 0,
    };

    created.push(newCard);
  }

  if (created.length > 0) {
    await db.cards.bulkPut(created);
    invalidateStatsCache();
  }

  return {
    created,
    skippedDuplicate,
    skippedNoSentence,
    skippedNoMatch,
  };
}

export async function createListeningCardsFromCards(
  cardIds: string[],
  listeningTarget: 'word' | 'sentence' = 'word'
): Promise<{
  created: CardItem[];
  skippedDuplicate: number;
}> {
  if (cardIds.length === 0) {
    return { created: [], skippedDuplicate: 0 };
  }

  const cards = (await db.cards.bulkGet(cardIds)).filter(Boolean) as CardItem[];
  const now = Date.now();
  const created: CardItem[] = [];
  let skippedDuplicate = 0;

  const existingKeysByLang = new Map<string, Set<string>>();
  const makeKey = (lemma: string, reading: string) =>
    `${lemma.trim()}\x1e${reading.trim()}`;

  const getLangKeys = async (langId: string) => {
    let set = existingKeysByLang.get(langId);
    if (set) return set;
    const existingListening = await db.cards
      .where('languageId')
      .equals(langId)
      .filter((c) => c.cardType === 'listening')
      .toArray();
    set = new Set<string>();
    for (const c of existingListening) {
      set.add(makeKey(c.lemma || c.word || '', c.reading || ''));
    }
    existingKeysByLang.set(langId, set);
    return set;
  };

  for (const src of cards) {
    const normalizedLemma = (src.lemma || src.word || '').trim();
    const normalizedReading = (src.reading || '').trim();
    const langKeys = await getLangKeys(src.languageId);
    const key = makeKey(normalizedLemma, normalizedReading);

    if (langKeys.has(key)) {
      skippedDuplicate++;
      continue;
    }

    langKeys.add(key);
    const sentenceText = (src.cloze?.sentence || src.sentence || '').trim();
    const effectiveTarget: 'word' | 'sentence' =
      listeningTarget === 'sentence' && sentenceText ? 'sentence' : 'word';

    const newCard: CardItem = {
      id: generateEntityId('card'),
      deckId: src.deckId,
      languageId: src.languageId,
      cardType: 'listening',
      word: src.word,
      lemma: normalizedLemma,
      reading: normalizedReading,
      furiganaSegments: src.furiganaSegments,
      meaning: src.meaning,
      partOfSpeech: src.partOfSpeech || '',
      level: src.level || '',
      frequencyBand: src.frequencyBand || '',
      sentence: sentenceText,
      sentenceFuriganaSegments: src.sentenceFuriganaSegments,
      listeningTarget: effectiveTarget,
      sourceDocTitle: src.sourceDocTitle || '',
      sourceDocId: src.sourceDocId,
      tags: Array.isArray(src.tags) ? [...src.tags] : [],
      notes: src.notes || '',
      createdAt: now,
      updatedAt: now,
      suspended: false,
      buried: false,
      due: now,
      stability: 0,
      difficulty: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      scheduledDays: 0,
      elapsedDays: 0,
      learningSteps: 0,
    };

    created.push(newCard);
  }

  if (created.length > 0) {
    await db.cards.bulkPut(created);
    invalidateStatsCache();
  }

  return {
    created,
    skippedDuplicate,
  };
}

export async function updateCard(id: string, patch: Partial<CardItem>): Promise<void> {
  await db.cards.update(id, {
    ...patch,
    updatedAt: Date.now(),
  });
  invalidateStatsCache();
}

export async function deleteCards(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.cards.bulkDelete(ids);
  invalidateStatsCache();
}

export async function bulkMoveCards(ids: string[], targetDeckId: string): Promise<void> {
  if (ids.length === 0) return;
  const cards = (await db.cards.bulkGet(ids)).filter(Boolean) as CardItem[];
  const now = Date.now();
  await db.cards.bulkPut(cards.map((c) => ({ ...c, deckId: targetDeckId, updatedAt: now })));
  invalidateStatsCache();
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
