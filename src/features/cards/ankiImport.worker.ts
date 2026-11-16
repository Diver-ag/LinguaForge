import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import {
  extractDatabaseFromApkgZip,
  openAndInspectAnkiDb,
  streamAnkiNoteBatches,
  type ApkgInspectSummary,
  type RawApkgNoteRecord,
} from '../../core/ankiImportCore';

export type AnkiImportWorkerRequest =
  | {
      type: 'inspect';
      jobId: string;
      apkgBuffer: ArrayBuffer;
      sqlWasmUrl?: string;
    }
  | {
      type: 'stream_notes';
      jobId: string;
      batchSize?: number;
    }
  | {
      type: 'cancel';
      jobId: string;
    }
  | {
      type: 'close';
    };

export type AnkiImportWorkerResponse =
  | {
      type: 'inspect_done';
      jobId: string;
      summary: ApkgInspectSummary;
      modelNames: Record<string, string>;
    }
  | {
      type: 'note_batch';
      jobId: string;
      batch: RawApkgNoteRecord[];
      processed: number;
      total: number;
    }
  | {
      type: 'stream_done';
      jobId: string;
      total: number;
      cancelled: boolean;
    }
  | {
      type: 'error';
      jobId: string;
      error: string;
    };

let cachedSqlJs: SqlJsStatic | null = null;
let cachedWasmUrl = '';
let activeDbConn: InstanceType<SqlJsStatic['Database']> | null = null;
let activeDeckNameById = new Map<string, string>();
let activeModelNameById = new Map<string, string>();
const cancelledJobs = new Set<string>();

async function getSqlJsInstance(wasmUrl: string): Promise<SqlJsStatic> {
  if (cachedSqlJs && cachedWasmUrl === wasmUrl) {
    return cachedSqlJs;
  }
  const initFn: any =
    typeof initSqlJs === 'function' ? initSqlJs : (initSqlJs as any)?.default;
  if (typeof initFn !== 'function') {
    throw new Error('Failed to load SQLite WASM initializer (sql.js).');
  }
  const inst = await initFn({
    locateFile: (file: string) => (file.endsWith('.wasm') ? wasmUrl : `/${file}`),
  });
  cachedSqlJs = inst;
  cachedWasmUrl = wasmUrl;
  return inst;
}

function closeActiveDb() {
  if (activeDbConn) {
    try {
      activeDbConn.close();
    } catch {
      // Ignore close error
    }
    activeDbConn = null;
  }
  activeDeckNameById = new Map();
  activeModelNameById = new Map();
}

self.onmessage = async (event: MessageEvent<AnkiImportWorkerRequest>) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'close') {
    closeActiveDb();
    return;
  }

  if (msg.type === 'cancel') {
    cancelledJobs.add(msg.jobId);
    return;
  }

  if (msg.type === 'inspect') {
    const { jobId, apkgBuffer, sqlWasmUrl } = msg;
    const wasmUrl = sqlWasmUrl || '/sql-wasm.wasm';
    closeActiveDb();

    try {
      const sqlJs = await getSqlJsInstance(wasmUrl);
      const { dbSource, sqliteBytes, skippedMediaCount, hasNewerDb } =
        await extractDatabaseFromApkgZip(apkgBuffer);

      const opened = openAndInspectAnkiDb(
        sqliteBytes,
        sqlJs,
        dbSource,
        skippedMediaCount,
        hasNewerDb
      );

      activeDbConn = opened.dbConn;
      activeDeckNameById = opened.deckNameById;
      activeModelNameById = opened.modelNameById;

      const modelNames: Record<string, string> = {};
      for (const [k, v] of opened.modelNameById.entries()) {
        modelNames[k] = v;
      }

      self.postMessage({
        type: 'inspect_done',
        jobId,
        summary: opened.summary,
        modelNames,
      } satisfies AnkiImportWorkerResponse);
    } catch (err: any) {
      closeActiveDb();
      self.postMessage({
        type: 'error',
        jobId,
        error: err?.message || 'Failed to read .apkg package.',
      } satisfies AnkiImportWorkerResponse);
    }
    return;
  }

  if (msg.type === 'stream_notes') {
    const { jobId, batchSize = 400 } = msg;
    cancelledJobs.delete(jobId);

    if (!activeDbConn) {
      self.postMessage({
        type: 'error',
        jobId,
        error: 'No Anki package is currently loaded. Please select the .apkg file again.',
      } satisfies AnkiImportWorkerResponse);
      return;
    }

    try {
      let totalNotes = 0;
      await streamAnkiNoteBatches(
        activeDbConn,
        activeDeckNameById,
        batchSize,
        async (batch, processed, total) => {
          totalNotes = total;
          self.postMessage({
            type: 'note_batch',
            jobId,
            batch,
            processed,
            total,
          } satisfies AnkiImportWorkerResponse);
          // Yield to allow cancel messages to be processed promptly
          await new Promise((r) => setTimeout(r, 0));
        },
        () => cancelledJobs.has(jobId)
      );

      const wasCancelled = cancelledJobs.has(jobId);
      cancelledJobs.delete(jobId);

      self.postMessage({
        type: 'stream_done',
        jobId,
        total: totalNotes,
        cancelled: wasCancelled,
      } satisfies AnkiImportWorkerResponse);
    } catch (err: any) {
      cancelledJobs.delete(jobId);
      self.postMessage({
        type: 'error',
        jobId,
        error: err?.message || 'Failed while streaming notes from Anki database.',
      } satisfies AnkiImportWorkerResponse);
    }
  }
};
