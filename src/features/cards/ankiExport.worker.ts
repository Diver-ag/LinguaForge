import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import {
  buildAndVerifyApkg,
  type AnkiExportPlan,
  type ApkgVerificationReport,
  type SqliteBuildProgress,
} from '../../core/ankiExportCore';

export type AnkiExportWorkerRequest =
  | {
      type: 'start';
      jobId: string;
      plan: AnkiExportPlan;
      sqlWasmUrl?: string;
    }
  | {
      type: 'cancel';
      jobId: string;
    };

export type AnkiExportWorkerResponse =
  | {
      type: 'progress';
      jobId: string;
      progress: SqliteBuildProgress;
    }
  | {
      type: 'done';
      jobId: string;
      zipBuffer: ArrayBuffer;
      verification: ApkgVerificationReport;
    }
  | {
      type: 'cancelled';
      jobId: string;
    }
  | {
      type: 'error';
      jobId: string;
      error: string;
    };

const cancelledJobs = new Set<string>();
let cachedSqlJs: SqlJsStatic | null = null;
let cachedWasmUrl = '';

async function getSqlJsInstance(wasmUrl: string): Promise<SqlJsStatic> {
  if (cachedSqlJs && cachedWasmUrl === wasmUrl) {
    return cachedSqlJs;
  }
  const initFn: any =
    typeof initSqlJs === 'function'
      ? initSqlJs
      : (initSqlJs as any)?.default;

  if (typeof initFn !== 'function') {
    throw new Error('Failed to load SQLite WASM initializer (sql.js).');
  }

  const instance = await initFn({
    locateFile: (file: string) => (file.endsWith('.wasm') ? wasmUrl : `/${file}`),
  });
  cachedSqlJs = instance;
  cachedWasmUrl = wasmUrl;
  return instance;
}

self.onmessage = async (event: MessageEvent<AnkiExportWorkerRequest>) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'cancel') {
    cancelledJobs.add(msg.jobId);
    return;
  }

  if (msg.type === 'start') {
    const { jobId, plan, sqlWasmUrl } = msg;
    const wasmUrl = sqlWasmUrl || '/sql-wasm.wasm';
    const isCancelled = () => cancelledJobs.has(jobId);

    try {
      self.postMessage({
        type: 'progress',
        jobId,
        progress: {
          phase: 'preparing',
          processed: 0,
          total: Math.max(1, plan.notes.length + plan.cards.length),
          percent: 3,
        },
      } satisfies AnkiExportWorkerResponse);

      const sqlJs = await getSqlJsInstance(wasmUrl);
      if (isCancelled()) {
        cancelledJobs.delete(jobId);
        self.postMessage({ type: 'cancelled', jobId } satisfies AnkiExportWorkerResponse);
        return;
      }

      const { zipBytes, verification } = await buildAndVerifyApkg(
        plan,
        sqlJs,
        (progress) => {
          self.postMessage({
            type: 'progress',
            jobId,
            progress,
          } satisfies AnkiExportWorkerResponse);
        },
        isCancelled
      );

      if (isCancelled()) {
        cancelledJobs.delete(jobId);
        self.postMessage({ type: 'cancelled', jobId } satisfies AnkiExportWorkerResponse);
        return;
      }

      // Copy into tightly-sized transferable ArrayBuffer
      const transferBuf = zipBytes.buffer.slice(
        zipBytes.byteOffset,
        zipBytes.byteOffset + zipBytes.byteLength
      ) as ArrayBuffer;

      (self as unknown as {
        postMessage: (message: unknown, transfer?: Transferable[]) => void;
      }).postMessage(
        {
          type: 'done',
          jobId,
          zipBuffer: transferBuf,
          verification,
        } satisfies AnkiExportWorkerResponse,
        [transferBuf]
      );
    } catch (err: any) {
      if (isCancelled() || String(err?.message || '').includes('cancelled')) {
        cancelledJobs.delete(jobId);
        self.postMessage({ type: 'cancelled', jobId } satisfies AnkiExportWorkerResponse);
      } else {
        self.postMessage({
          type: 'error',
          jobId,
          error: err?.message || 'An unexpected error occurred while building the .apkg file.',
        } satisfies AnkiExportWorkerResponse);
      }
    } finally {
      cancelledJobs.delete(jobId);
    }
  }
};
