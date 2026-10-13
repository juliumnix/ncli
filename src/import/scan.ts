import { existsSync, readFileSync } from "node:fs";
import { listSessionFiles, parseSessionStream } from "./parse";
import type { FileCursor } from "./checkpoint";
import type { ImportLine } from "./types";
import { IMPORT_YIELD_MS, type ImportScanIn, type ImportScanOut } from "./protocol";

export type ScanSend = (msg: ImportScanOut) => void;
export type ScanWait = () => Promise<void>;

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

function cursorOf(cursors: FileCursor[], path: string): FileCursor | undefined {
  return cursors.find((c) => c.path === path);
}

export async function runImportScan(
  job: Extract<ImportScanIn, { type: "run" }>,
  send: ScanSend,
  waitPull: ScanWait,
  signal?: AbortSignal,
): Promise<void> {
  const seen = loadSeen(job.seenFile);
  const files = listSessionFiles(job.root, job.source);
  const sinceMs = job.since ? Date.parse(job.since) : undefined;
  const total = files.length;
  send({ type: "progress", source: job.source, done: 0, total });
  let applied = 0;
  let seenCount = 0;
  let skipped = 0;
  let filesSkipped = 0;
  let filesScanned = 0;
  let batch: ImportLine[] = [];
  let batchBytes = 0;
  let batchFile = "";
  const flush = async (fileDone: boolean): Promise<void> => {
    const file = batchFile;
    if (!batch.length) {
      if (fileDone && file) send({ type: "cursor", file, fileDone: true, done: 0, total });
      return;
    }
    const lastFingerprint = batch.at(-1)?.fingerprint;
    send({ type: "batch", lines: batch, file, fileDone });
    send({ type: "cursor", file, lastFingerprint, fileDone, done: 0, total });
    batch = [];
    batchBytes = 0;
    await waitPull();
    if (signal?.aborted) return;
    await Bun.sleep(0);
  };
  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) return;
    const file = files[i]!;
    const cur = cursorOf(job.cursors, file);
    if (cur?.status === "done") {
      filesSkipped += 1;
      send({ type: "progress", source: job.source, done: i + 1, total });
      continue;
    }
    filesScanned += 1;
    batchFile = file;
    let after = cur?.lastFingerprint;
    let skipUntil = Boolean(after);
    for await (const line of parseSessionStream(job.source, file)) {
      if (sinceMs !== undefined) {
        const at = Date.parse(line.at);
        if (!Number.isFinite(at) || at < sinceMs) {
          skipped += 1;
          continue;
        }
      }
      if (skipUntil) {
        if (line.fingerprint === after) skipUntil = false;
        seenCount += 1;
        continue;
      }
      if (seen.has(line.fingerprint)) {
        seenCount += 1;
        continue;
      }
      seen.add(line.fingerprint);
      const n = line.text.length + 80;
      if (batch.length >= job.batch || batchBytes + n > job.memCap) await flush(false);
      batch.push(line);
      batchBytes += n;
      applied += 1;
    }
    await flush(true);
    send({ type: "progress", source: job.source, done: i + 1, total });
    await Bun.sleep(IMPORT_YIELD_MS);
  }
  send({ type: "done", applied, seenCount, skipped, sessions: files.length, filesSkipped, filesScanned });
}
