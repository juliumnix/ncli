import type { FileCursor } from "./checkpoint";
import type { ImportLine, ImportSource } from "./types";

export const IMPORT_BATCH_LINES = 32;
export const IMPORT_BATCH_BYTES = 256 * 1024;
export const IMPORT_YIELD_MS = 8;

export type ImportWorkerIn =
  | {
      type: "run";
      source: ImportSource;
      root: string;
      since?: string;
      seenFile: string;
      cursors: FileCursor[];
      batch: number;
      memCap: number;
    }
  | { type: "pull" }
  | { type: "stop" };

export type ImportWorkerOut =
  | { type: "progress"; source: ImportSource; done: number; total: number }
  | { type: "batch"; lines: ImportLine[]; file: string; fileDone: boolean }
  | { type: "cursor"; file: string; lastFingerprint?: string; fileDone: boolean; done: number; total: number }
  | { type: "done"; applied: number; seenCount: number; skipped: number; sessions: number; filesSkipped: number; filesScanned: number }
  | { type: "error"; message: string };

export function importWorkerUrl(): URL {
  return new URL("./worker.ts", import.meta.url);
}
