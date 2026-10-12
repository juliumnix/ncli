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
      batch: number;
      memCap: number;
    }
  | { type: "pull" }
  | { type: "stop" };

export type ImportWorkerOut =
  | { type: "progress"; source: ImportSource; done: number; total: number }
  | { type: "batch"; lines: ImportLine[] }
  | { type: "done"; applied: number; seenCount: number; skipped: number; sessions: number }
  | { type: "error"; message: string };

export function importWorkerUrl(): URL {
  return new URL("./worker.ts", import.meta.url);
}
