import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImportSource } from "./types";

export type FileCursor = {
  path: string;
  status: "pending" | "done";
  lastFingerprint?: string;
};

export type ImportCheckpoint = {
  source: ImportSource;
  since?: string;
  surface: boolean;
  files: FileCursor[];
  done: number;
  total: number;
  updatedAt: string;
};

export function checkpointPath(dir: string): string {
  return join(dir, "import-resume.json");
}

export function loadCheckpoint(dir: string): ImportCheckpoint | null {
  const path = checkpointPath(dir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ImportCheckpoint;
    if (!raw || (raw.source !== "claude" && raw.source !== "codex" && raw.source !== "cursor")) return null;
    if (!Array.isArray(raw.files)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveCheckpoint(dir: string, cp: ImportCheckpoint): void {
  mkdirSync(dir, { recursive: true });
  const path = checkpointPath(dir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cp)}\n`, "utf8");
  renameSync(tmp, path);
}

export function clearCheckpoint(dir: string): void {
  const path = checkpointPath(dir);
  if (existsSync(path)) unlinkSync(path);
}

export function isResumeOpen(cp: ImportCheckpoint | null): boolean {
  return Boolean(cp && cp.files.some((f) => f.status !== "done"));
}

export function openCheckpoint(
  source: ImportSource,
  files: string[],
  opts: { since?: string; surface: boolean },
): ImportCheckpoint {
  return {
    source,
    since: opts.since,
    surface: opts.surface,
    files: files.map((path) => ({ path, status: "pending" as const })),
    done: 0,
    total: files.length,
    updatedAt: new Date().toISOString(),
  };
}

export function mergeCheckpoint(
  existing: ImportCheckpoint | null,
  source: ImportSource,
  files: string[],
  opts: { since?: string; surface: boolean },
): ImportCheckpoint {
  if (!existing || existing.source !== source) return openCheckpoint(source, files, opts);
  const prev = new Map(existing.files.map((f) => [f.path, f]));
  const next = files.map((path) => prev.get(path) ?? { path, status: "pending" as const });
  return {
    ...existing,
    since: opts.since ?? existing.since,
    surface: opts.surface,
    files: next,
    done: next.filter((f) => f.status === "done").length,
    total: next.length,
    updatedAt: new Date().toISOString(),
  };
}

export function applyCursor(
  cp: ImportCheckpoint,
  file: string,
  lastFingerprint: string | undefined,
  fileDone: boolean,
): ImportCheckpoint {
  const files = cp.files.map((f) => {
    if (f.path !== file) return f;
    return {
      path: file,
      status: fileDone ? ("done" as const) : ("pending" as const),
      lastFingerprint: lastFingerprint ?? f.lastFingerprint,
    };
  });
  return {
    ...cp,
    files,
    done: files.filter((f) => f.status === "done").length,
    total: files.length,
    updatedAt: new Date().toISOString(),
  };
}
