import { rootFor } from "./roots";
import type { ImportApply, ImportLine, ImportRoots, ImportSource } from "./types";
import {
  IMPORT_BATCH_BYTES,
  IMPORT_BATCH_LINES,
  importWorkerUrl,
  type ImportWorkerIn,
  type ImportWorkerOut,
} from "./protocol";
import type { ImportProgress } from "./progress";

export type ImportJobOpts = {
  source: ImportSource;
  roots: ImportRoots;
  since?: string;
  seenFile: string;
  onProgress?: (progress: ImportProgress) => void;
  onBatch: (lines: ImportLine[]) => void | Promise<void>;
  batch?: number;
  memCap?: number;
};

export async function runImportJob(opts: ImportJobOpts): Promise<ImportApply> {
  const worker = new Worker(importWorkerUrl());
  const source = opts.source;
  const root = rootFor(source, opts.roots);
  const start: Extract<ImportWorkerIn, { type: "run" }> = {
    type: "run",
    source,
    root,
    since: opts.since,
    seenFile: opts.seenFile,
    batch: opts.batch ?? IMPORT_BATCH_LINES,
    memCap: opts.memCap ?? IMPORT_BATCH_BYTES,
  };
  return new Promise<ImportApply>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      fn();
    };
    worker.onmessage = (ev: MessageEvent<ImportWorkerOut>) => {
      const msg = ev.data;
      switch (msg.type) {
        case "progress":
          opts.onProgress?.({ source: msg.source, done: msg.done, total: msg.total });
          return;
        case "batch":
          void Promise.resolve(opts.onBatch(msg.lines))
            .then(() => {
              if (!settled) worker.postMessage({ type: "pull" } satisfies ImportWorkerIn);
            })
            .catch((err) => finish(() => reject(err)));
          return;
        case "done":
          finish(() =>
            resolve({
              preview: {
                source,
                root,
                sessions: msg.sessions,
                lines: [],
                newCount: 0,
                seenCount: msg.seenCount + msg.applied,
                skipped: msg.skipped,
                since: opts.since,
              },
              applied: msg.applied,
            }),
          );
          return;
        case "error":
          finish(() => reject(new Error(msg.message)));
          return;
        default: {
          const _n: never = msg;
          finish(() => reject(new Error(`unknown worker out: ${JSON.stringify(_n)}`)));
        }
      }
    };
    worker.onerror = (err) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    };
    worker.postMessage(start);
  });
}
