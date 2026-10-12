import { existsSync, readFileSync } from "node:fs";
import { listSessionFiles, parseSessionStream } from "./parse";
import type { ImportLine } from "./types";
import { IMPORT_YIELD_MS, type ImportWorkerIn, type ImportWorkerOut } from "./protocol";

let waiting: (() => void) | undefined;

function send(msg: ImportWorkerOut): void {
  postMessage(msg);
}

function waitPull(): Promise<void> {
  return new Promise((resolve) => {
    waiting = resolve;
  });
}

function loadSeen(path: string): Set<string> {
  const seen = new Set<string>();
  if (!existsSync(path)) return seen;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { fingerprints?: unknown };
    for (const fp of raw.fingerprints ?? []) {
      if (typeof fp === "string" && fp) seen.add(fp);
    }
  } catch {
    return seen;
  }
  return seen;
}

async function run(job: Extract<ImportWorkerIn, { type: "run" }>): Promise<void> {
  const seen = loadSeen(job.seenFile);
  const files = listSessionFiles(job.root, job.source);
  const sinceMs = job.since ? Date.parse(job.since) : undefined;
  send({ type: "progress", source: job.source, done: 0, total: files.length });
  let applied = 0;
  let seenCount = 0;
  let skipped = 0;
  let batch: ImportLine[] = [];
  let batchBytes = 0;
  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    send({ type: "batch", lines: batch });
    batch = [];
    batchBytes = 0;
    await waitPull();
    await Bun.sleep(0);
  };
  for (let i = 0; i < files.length; i++) {
    for await (const line of parseSessionStream(job.source, files[i]!)) {
      if (sinceMs !== undefined) {
        const at = Date.parse(line.at);
        if (!Number.isFinite(at) || at < sinceMs) {
          skipped += 1;
          continue;
        }
      }
      if (seen.has(line.fingerprint)) {
        seenCount += 1;
        continue;
      }
      seen.add(line.fingerprint);
      const n = line.text.length + 80;
      if (batch.length >= job.batch || batchBytes + n > job.memCap) await flush();
      batch.push(line);
      batchBytes += n;
      applied += 1;
    }
    send({ type: "progress", source: job.source, done: i + 1, total: files.length });
    await Bun.sleep(IMPORT_YIELD_MS);
  }
  await flush();
  send({ type: "done", applied, seenCount, skipped, sessions: files.length });
}

onmessage = (ev: MessageEvent<ImportWorkerIn>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "pull":
      waiting?.();
      waiting = undefined;
      return;
    case "stop":
      waiting?.();
      waiting = undefined;
      return;
    case "run":
      void run(msg).catch((err) => {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      });
      return;
    default: {
      const _n: never = msg;
      send({ type: "error", message: `unknown worker in: ${JSON.stringify(_n)}` });
    }
  }
};
