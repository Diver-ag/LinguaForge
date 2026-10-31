import { db } from '../db/db';
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
  eventLogs: any[];
}

export async function exportFullBackup(): Promise<string> {
  const documents = await db.documents.toArray();
  const wordStatuses = await db.wordStatuses.toArray();
  const lookups = await db.lookups.toArray();
  const settings = await db.settings.toArray();
  const flashcards = await db.flashcards.toArray();
  const eventLogs = await db.eventLogs.toArray();

  const backup: LinguaForgeBackupData = {
    version: 1,
    appName: 'LinguaForge',
    exportedAt: new Date().toISOString(),
    documents,
    wordStatuses,
    lookups,
    settings,
    flashcards,
    eventLogs,
  };

  await logEvent('backup_exported', {
    docCount: documents.length,
    wordsCount: wordStatuses.length,
    lookupsCount: lookups.length,
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

    await db.transaction('rw', [db.documents, db.wordStatuses, db.lookups, db.settings, db.flashcards], async () => {
      if (Array.isArray(data.documents) && data.documents.length > 0) {
        await db.documents.clear();
        await db.documents.bulkAdd(data.documents);
      }
      if (Array.isArray(data.wordStatuses) && data.wordStatuses.length > 0) {
        await db.wordStatuses.clear();
        await db.wordStatuses.bulkAdd(data.wordStatuses);
      }
      if (Array.isArray(data.lookups) && data.lookups.length > 0) {
        await db.lookups.clear();
        await db.lookups.bulkAdd(data.lookups);
      }
      if (Array.isArray(data.settings) && data.settings.length > 0) {
        await db.settings.clear();
        await db.settings.bulkAdd(data.settings);
      }
      if (Array.isArray(data.flashcards) && data.flashcards.length > 0) {
        await db.flashcards.clear();
        await db.flashcards.bulkAdd(data.flashcards);
      }
    });

    await logEvent('backup_restored', {
      exportedAt: data.exportedAt,
      docsRestored: data.documents?.length || 0,
    });

    return {
      success: true,
      message: `Successfully restored ${data.documents?.length || 0} documents, ${data.wordStatuses?.length || 0} word statuses, and ${data.lookups?.length || 0} lookups.`,
    };
  } catch (err: any) {
    return { success: false, message: `Backup restoration failed: ${err.message || String(err)}` };
  }
}
