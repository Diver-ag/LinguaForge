import { db, type CardItem, type FlashcardItem } from '../db/db';
import { ensureAllDefaultDecks, ensureDefaultDeck } from '../db/cards';
import { logEvent } from './eventLogger';

export interface LinguaForgeBackupData {
  version: number;
  appName: string;
  exportedAt: string;
  documents: any[];
  wordStatuses: any[];
  lookups: any[];
  settings: any[];
  flashcards: any[];
  decks?: any[];
  cards?: any[];
  reviewLogs?: any[];
  exportHistory?: any[];
  installedLanguagePacks?: any[];
  languagePackMetadata?: {
    installedLanguageIds: string[];
    versions: Record<string, string>;
    activeLanguageId: string;
    manifestUrl: string;
    developerMode: boolean;
  };
  eventLogs: any[];
}

const DEFAULT_MANIFEST_URL =
  'https://cdn.jsdelivr.net/gh/Diver-ag/linguaforge-packs@main/packs/manifest.json';

export async function exportFullBackup(): Promise<string> {
  const [
    documents,
    wordStatuses,
    lookups,
    settings,
    flashcards,
    decks,
    cards,
    reviewLogs,
    exportHistory,
    installedLanguagePacks,
    eventLogs,
  ] = await Promise.all([
    db.documents.toArray(),
    db.wordStatuses.toArray(),
    db.lookups.toArray(),
    db.settings.toArray(),
    db.flashcards.toArray(),
    db.decks.toArray(),
    db.cards.toArray(),
    db.reviewLogs.toArray(),
    db.exportHistory.toArray(),
    db.installedPacks.toArray(),
    db.eventLogs.toArray(),
  ]);

  const cleanSettings = settings
    .filter((s) => s.key !== 'demoSyntheticMeta')
    .map((s) =>
      s.key === 'developerSettings'
        ? {
            key: 'developerSettings',
            value: {
              showDeveloperTools: Boolean(s.value?.showDeveloperTools),
              includeDemoData: false,
            },
          }
        : s
    );
  const cleanReviewLogs = reviewLogs.filter((r) => !r.isDemo);

  const settingsMap = new Map<string, any>(cleanSettings.map((s) => [s.key, s.value]));
  const activeLanguageId = String(
    settingsMap.get('activeLanguageId') || settingsMap.get('activeLanguage') || 'ja'
  );
  const manifestUrl = String(settingsMap.get('packManifestUrl') || DEFAULT_MANIFEST_URL);
  const developerMode = Boolean(settingsMap.get('developerSettings')?.showDeveloperTools);

  if (!settingsMap.has('activeLanguageId')) {
    cleanSettings.push({ key: 'activeLanguageId', value: activeLanguageId });
  }
  if (!settingsMap.has('packManifestUrl')) {
    cleanSettings.push({ key: 'packManifestUrl', value: manifestUrl });
  }
  if (!settingsMap.has('developerSettings')) {
    cleanSettings.push({
      key: 'developerSettings',
      value: { showDeveloperTools: developerMode, includeDemoData: false },
    });
  }

  const versions: Record<string, string> = {};
  for (const p of installedLanguagePacks) {
    if (p?.languageId) {
      versions[p.languageId] = String(p.version || '1.0.0');
    }
  }

  const backup: LinguaForgeBackupData = {
    version: 2,
    appName: 'LinguaForge',
    exportedAt: new Date().toISOString(),
    documents,
    wordStatuses,
    lookups,
    settings: cleanSettings,
    flashcards,
    decks,
    cards,
    reviewLogs: cleanReviewLogs,
    exportHistory,
    installedLanguagePacks,
    languagePackMetadata: {
      installedLanguageIds: installedLanguagePacks.map((p) => p.languageId).filter(Boolean),
      versions,
      activeLanguageId,
      manifestUrl,
      developerMode,
    },
    eventLogs,
  };

  await logEvent('backup_exported', {
    docCount: documents.length,
    wordsCount: wordStatuses.length,
    lookupsCount: lookups.length,
    cardsCount: cards.length,
    decksCount: decks.length,
  });

  return JSON.stringify(backup, null, 2);
}

export async function downloadBackupFile(): Promise<void> {
  const json = await exportFullBackup();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `linguaforge-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function restoreFromBackup(jsonData: string): Promise<{ success: boolean; message: string }> {
  try {
    const data = JSON.parse(jsonData) as Partial<LinguaForgeBackupData>;
    if (!data.appName || data.appName !== 'LinguaForge') {
      return { success: false, message: 'Invalid backup file: missing LinguaForge signature.' };
    }

    await db.transaction(
      'rw',
      [
        db.documents,
        db.wordStatuses,
        db.lookups,
        db.settings,
        db.flashcards,
        db.decks,
        db.cards,
        db.reviewLogs,
        db.exportHistory,
        db.installedPacks,
      ],
      async () => {
        if (Array.isArray(data.documents)) {
          await db.documents.clear();
          if (data.documents.length > 0) await db.documents.bulkPut(data.documents);
        }
        if (Array.isArray(data.wordStatuses)) {
          await db.wordStatuses.clear();
          if (data.wordStatuses.length > 0) await db.wordStatuses.bulkPut(data.wordStatuses);
        }
        if (Array.isArray(data.lookups)) {
          await db.lookups.clear();
          if (data.lookups.length > 0) await db.lookups.bulkPut(data.lookups);
        }
        if (Array.isArray(data.settings)) {
          await db.settings.clear();
          const cleanSettings = data.settings
            .filter((s: any) => s?.key !== 'demoSyntheticMeta')
            .map((s: any) =>
              s?.key === 'developerSettings'
                ? {
                    key: 'developerSettings',
                    value: {
                      showDeveloperTools: Boolean(s.value?.showDeveloperTools),
                      includeDemoData: false,
                    },
                  }
                : s
            );
          if (cleanSettings.length > 0) await db.settings.bulkPut(cleanSettings);
        }
        if (data.languagePackMetadata) {
          const meta = data.languagePackMetadata;
          if (meta.activeLanguageId) {
            await db.settings.put({ key: 'activeLanguageId', value: meta.activeLanguageId });
          }
          if (meta.manifestUrl) {
            await db.settings.put({ key: 'packManifestUrl', value: meta.manifestUrl });
          }
          if (typeof meta.developerMode === 'boolean') {
            await db.settings.put({
              key: 'developerSettings',
              value: { showDeveloperTools: meta.developerMode, includeDemoData: false },
            });
          }
        }
        if (Array.isArray(data.flashcards)) {
          await db.flashcards.clear();
          if (data.flashcards.length > 0) await db.flashcards.bulkPut(data.flashcards);
        }

        // Restore v2 card/deck/reviewLog tables when present
        if (Array.isArray(data.decks)) {
          await db.decks.clear();
          if (data.decks.length > 0) await db.decks.bulkPut(data.decks);
        }
        if (Array.isArray(data.cards)) {
          await db.cards.clear();
          const now = Date.now();
          const normalizedCards: CardItem[] = data.cards.map((c: any) => ({
            ...c,
            tags: Array.isArray(c.tags) ? c.tags : [],
            notes: c.notes ?? '',
            cloze:
              c.cloze && typeof c.cloze === 'object'
                ? {
                    sentence: String(c.cloze.sentence ?? c.sentence ?? ''),
                    start: Number(c.cloze.start ?? 0),
                    end: Number(c.cloze.end ?? 0),
                    answer: String(c.cloze.answer ?? c.word ?? ''),
                    lemma: String(c.cloze.lemma ?? c.lemma ?? c.word ?? ''),
                    reading: String(c.cloze.reading ?? c.reading ?? ''),
                    hint: c.cloze.hint !== undefined ? String(c.cloze.hint) : undefined,
                  }
                : undefined,
            listeningTarget:
              c.cardType === 'listening'
                ? c.listeningTarget === 'sentence'
                  ? 'sentence'
                  : 'word'
                : undefined,
            suspended: Boolean(c.suspended),
            buried: Boolean(c.buried),
            state: c.state ?? 0,
            stability: c.stability ?? 0,
            difficulty: c.difficulty ?? 0,
            reps: c.reps ?? 0,
            lapses: c.lapses ?? 0,
            scheduledDays: c.scheduledDays ?? 0,
            elapsedDays: c.elapsedDays ?? 0,
            learningSteps: c.learningSteps ?? 0,
            due: c.due ?? c.createdAt ?? now,
          }));
          if (normalizedCards.length > 0) await db.cards.bulkPut(normalizedCards);
        } else if (Array.isArray(data.flashcards) && data.flashcards.length > 0) {
          // Legacy v1 backup compatibility: map flashcards into cards + default decks
          const migrated: CardItem[] = (data.flashcards as FlashcardItem[]).map((fc, idx) => {
            const langId = fc.languageId || 'ja';
            const created = fc.createdAt || Date.now();
            return {
              id: fc.id !== undefined ? `card-legacy-${fc.id}` : `card-legacy-${created}-${idx}`,
              deckId: `default-${langId}`,
              languageId: langId,
              cardType: 'word_to_meaning',
              word: fc.word || '',
              lemma: fc.lemma || fc.word || '',
              reading: fc.reading || '',
              furiganaSegments: fc.furiganaSegments,
              meaning: fc.meaning || '',
              partOfSpeech: '',
              level: fc.level || '',
              frequencyBand: '',
              sentence: fc.sentence || '',
              sentenceFuriganaSegments: fc.sentenceFuriganaSegments,
              sourceDocTitle: fc.sourceDocTitle || '',
              tags: [],
              notes: '',
              createdAt: created,
              updatedAt: created,
              suspended: false,
              buried: false,
              due: created,
              stability: 0,
              difficulty: 0,
              reps: 0,
              lapses: 0,
              state: 0,
              scheduledDays: 0,
              elapsedDays: 0,
              learningSteps: 0,
            };
          });
          await db.cards.clear();
          await db.cards.bulkPut(migrated);
        }

        if (Array.isArray(data.reviewLogs)) {
          await db.reviewLogs.clear();
          const realLogs = data.reviewLogs.filter((l: any) => !l?.isDemo);
          if (realLogs.length > 0) await db.reviewLogs.bulkPut(realLogs);
        }
        if (Array.isArray(data.exportHistory)) {
          await db.exportHistory.clear();
          if (data.exportHistory.length > 0) await db.exportHistory.bulkPut(data.exportHistory);
        }
        if (Array.isArray(data.installedLanguagePacks)) {
          await db.installedPacks.clear();
          if (data.installedLanguagePacks.length > 0) {
            await db.installedPacks.bulkPut(data.installedLanguagePacks);
          }
        }
      }
    );

    // Guarantee default decks exist after restore
    await ensureAllDefaultDecks();
    if (Array.isArray(data.cards)) {
      const langs = new Set<string>(data.cards.map((c: any) => c.languageId).filter(Boolean));
      for (const l of langs) {
        await ensureDefaultDeck(l);
      }
    }

    await logEvent('backup_restored', {
      exportedAt: data.exportedAt,
      docsRestored: data.documents?.length || 0,
      cardsRestored: data.cards?.length || data.flashcards?.length || 0,
      decksRestored: data.decks?.length || 0,
    });

    const restoredCardsCount = Array.isArray(data.cards)
      ? data.cards.length
      : data.flashcards?.length || 0;
    const restoredDecksCount = Array.isArray(data.decks) ? data.decks.length : 0;

    return {
      success: true,
      message: `Successfully restored ${data.documents?.length || 0} documents, ${restoredCardsCount} cards${restoredDecksCount ? `, ${restoredDecksCount} decks` : ''}, ${data.wordStatuses?.length || 0} word statuses, and ${data.lookups?.length || 0} lookups.`,
    };
  } catch (err: any) {
    return { success: false, message: `Backup restoration failed: ${err.message || String(err)}` };
  }
}
