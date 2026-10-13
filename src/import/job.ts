import { runImportScan } from "./scan";
import { rootFor } from "./roots";
import type { ImportApply, ImportLine, ImportRoots, ImportSource } from "./types";
import type { FileCursor } from "./checkpoint";
import {
  IMPORT_BATCH_BYTES,
  IMPORT_BATCH_LINES,
  type ImportScanIn,
  type ImportScanOut,
} from "./protocol";
import type { ImportProgress } from "./progress";

export type ImportBatchMeta = {
  file: string;
  fileDone: boolean;
};

export type ImportJobOpts = {
  source: ImportSource;
  roots: ImportRoots;
  since?: string;
  seenFile: string;
  cursors?: FileCursor[];
  onProgress?: (progress: ImportProgress) => void;
  onCursor?: (file: string, lastFingerprint: string | undefined, fileDone: boolean) => void;
  onBatch: (lines: ImportLine[], meta: ImportBatchMeta) => void | Promise<void>;
  batch?: number;
  memCap?: number;
  signal?: AbortSignal;
};

export async function runImportJob(opts: ImportJobOpts): Promise<ImportApply> {
  if (opts.signal?.aborted) throw new Error("import stopped");
  const source = opts.source;
  const root = rootFor(source, opts.roots);
  const start: Extract<ImportScanIn, { type: "run" }> = {
    type: "run",
    source,
    root,
    since: opts.since,
    seenFile: opts.seenFile,
    cursors: opts.cursors ?? [],
    batch: opts.batch ?? IMPORT_BATCH_LINES,
    memCap: opts.memCap ?? IMPORT_BATCH_BYTES,
  };
  let batchWork: Promise<void> = Promise.resolve();
  let done: Extract<ImportScanOut, { type: "done" }> | undefined;
  const send = (msg: ImportScanOut): void => {
    if (opts.signal?.aborted) return;
    switch (msg.type) {
      case "progress":
        opts.onProgress?.({ source: msg.source, done: msg.done, total: msg.total });
        return;
      case "cursor":
        opts.onCursor?.(msg.file, msg.lastFingerprint, msg.fileDone);
        return;
      case "batch":
        batchWork = Promise.resolve(opts.onBatch(msg.lines, { file: msg.file, fileDone: msg.fileDone }));
        return;
      case "done":
        done = msg;
        return;
      case "error":
        throw new Error(msg.message);
      default: {
        const _n: never = msg;
        throw new Error(`unknown scan out: ${JSON.stringify(_n)}`);
      }
    }
  };
  const waitPull = async () => {
    await batchWork;
    if (opts.signal?.aborted) throw new Error("import stopped");
  };
  await runImportScan(start, send, waitPull, opts.signal);
  if (opts.signal?.aborted) throw new Error("import stopped");
  if (!done) throw new Error("import scan exited");
  return {
    preview: {
      source,
      root,
      sessions: done.sessions,
      lines: [],
      newCount: 0,
      seenCount: done.seenCount + done.applied,
      skipped: done.skipped,
      since: opts.since,
    },
    applied: done.applied,
    filesSkipped: done.filesSkipped,
    filesScanned: done.filesScanned,
  };
}
