import { fileURLToPath } from "node:url";
import { childEnv } from "../harness/child-env";
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

export function importScanProc(): string {
  return fileURLToPath(new URL("./scan-proc.ts", import.meta.url));
}

export async function runImportJob(opts: ImportJobOpts): Promise<ImportApply> {
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
  const child = Bun.spawn({
    cmd: [process.execPath, importScanProc()],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: childEnv(process.env),
  });
  const send = (msg: ImportScanIn) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
    child.stdin.flush();
  };
  return new Promise<ImportApply>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        child.stdin.end();
      } catch {}
      void child.exited;
      fn();
    };
    const onAbort = () => {
      send({ type: "stop" });
      finish(() => reject(new Error("import stopped")));
    };
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    void readJsonl(child.stdout, async (msg: ImportScanOut) => {
      if (settled) return;
      switch (msg.type) {
        case "progress":
          opts.onProgress?.({ source: msg.source, done: msg.done, total: msg.total });
          return;
        case "cursor":
          opts.onCursor?.(msg.file, msg.lastFingerprint, msg.fileDone);
          return;
        case "batch":
          try {
            await opts.onBatch(msg.lines, { file: msg.file, fileDone: msg.fileDone });
            if (!settled) send({ type: "pull" });
          } catch (err) {
            finish(() => reject(err));
          }
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
              filesSkipped: msg.filesSkipped,
              filesScanned: msg.filesScanned,
            }),
          );
          return;
        case "error":
          finish(() => reject(new Error(msg.message)));
          return;
        default: {
          const _n: never = msg;
          finish(() => reject(new Error(`unknown scan out: ${JSON.stringify(_n)}`)));
        }
      }
    }).then(
      () => finish(() => reject(new Error("import scan exited"))),
      (err) => finish(() => reject(err)),
    );
    send(start);
  });
}

async function readJsonl(stream: ReadableStream<Uint8Array>, onMsg: (msg: ImportScanOut) => void | Promise<void>): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (raw) await onMsg(JSON.parse(raw) as ImportScanOut);
      nl = buf.indexOf("\n");
    }
  }
}
