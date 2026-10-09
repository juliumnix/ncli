import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function cursorCliConfigPath(home = homedir()): string {
  return join(home, ".cursor", "cli-config.json");
}

export function readCursorDefaultModel(cliConfigPath: string): string | undefined {
  if (!existsSync(cliConfigPath)) return undefined;
  try {
    const json = JSON.parse(readFileSync(cliConfigPath, "utf8")) as Record<string, unknown>;
    return pickModel(json);
  } catch {
    return undefined;
  }
}

function pickModel(json: Record<string, unknown>): string | undefined {
  const direct = json.model;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (direct && typeof direct === "object") {
    const rec = direct as Record<string, unknown>;
    for (const key of ["defaultModel", "modelId", "id", "current"]) {
      const v = rec[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  for (const key of ["defaultModel", "modelId"]) {
    const v = json[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function cursorConfigLooksPolluted(model: string | undefined, compactModel: string): boolean {
  if (!model) return false;
  if (model === compactModel) return true;
  return /haiku/i.test(model);
}

export function cursorPollutionWarning(opts: {
  cliConfigPath: string;
  compactModel: string;
  original?: string;
}): string | null {
  const model = readCursorDefaultModel(opts.cliConfigPath);
  if (!cursorConfigLooksPolluted(model, opts.compactModel)) return null;
  const known = opts.original?.trim();
  return [
    "NCLI will not rewrite your Cursor CLI config.",
    `File: ${opts.cliConfigPath}`,
    `Current default model: ${model}`,
    known ? `Original value: ${known}` : "Original value is not known.",
    "A past compaction run launched cursor-agent --print --model and Cursor saved that as the interactive default.",
    "Pick the model you want in an interactive cursor-agent session, or edit that file yourself.",
  ].join("\n");
}

export function holdFile(path: string): () => void {
  const existed = existsSync(path);
  const bytes = existed ? readFileSync(path) : null;
  return () => restoreFile(path, existed, bytes);
}

export async function withUnchangedFile<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const release = holdFile(path);
  try {
    return await fn();
  } finally {
    release();
  }
}

function restoreFile(path: string, existed: boolean, bytes: Buffer | null): void {
  if (bytes) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.ncli-restore`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
    return;
  }
  if (!existed && existsSync(path)) unlinkSync(path);
}
