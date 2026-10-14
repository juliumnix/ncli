import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NcliConfig } from "../config";
import type { CompactProvider } from "./compact-choice";
import { CompactCliError, isCliAuthMessage, isCliMissingMessage } from "./compact-deferred";
import { bunCompactSpawn, readChildText, type CompactSpawn } from "./compact-proc";

export type CompactModelCache = {
  provider: CompactProvider;
  models: string[];
  fetchedAt: number;
  error?: string;
};

export const COMPACT_MODELS_CACHE = "compact-models-cache.json";
export const COMPACT_MODELS_TTL_MS = 60 * 60 * 1000;

export type CompactModelLister = (
  provider: CompactProvider,
  cfg: NcliConfig,
) => Promise<string[]>;

export function parseModelList(stdout: string, stderr = ""): string[] {
  const text = `${stdout}\n${stderr}`.trim();
  if (!text) return [];
  try {
    const json = JSON.parse(stdout) as unknown;
    const fromJson = idsFromUnknown(json);
    if (fromJson.length) return fromJson;
  } catch {
    const last = stdout.split("\n").filter(Boolean).at(-1) ?? "";
    try {
      const fromJson = idsFromUnknown(JSON.parse(last));
      if (fromJson.length) return fromJson;
    } catch {
    }
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /\s{2,}/.test(line) && /help|usage|option/i.test(line)) continue;
    const token = line.split(/\s+/)[0] ?? "";
    const id = token.replace(/[,:]$/, "");
    if (!looksLikeModelId(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function pickCheapModel(ids: string[]): string {
  const cheap = ids.find((id) => /haiku|mini|nano|small|fast|lite/i.test(id));
  return cheap ?? ids[0] ?? "";
}

export function loadModelCache(dir: string, provider: CompactProvider, now = Date.now()): CompactModelCache | null {
  const path = join(dir, COMPACT_MODELS_CACHE);
  if (!existsSync(path)) return null;
  try {
    const row = JSON.parse(readFileSync(path, "utf8")) as CompactModelCache;
    if (row.provider !== provider) return null;
    if (!Array.isArray(row.models)) return null;
    if (now - row.fetchedAt > COMPACT_MODELS_TTL_MS) return null;
    return row;
  } catch {
    return null;
  }
}

export function saveModelCache(dir: string, row: CompactModelCache): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, COMPACT_MODELS_CACHE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(row)}\n`);
  renameSync(tmp, path);
}

export async function listProviderModels(
  provider: CompactProvider,
  cfg: NcliConfig,
  deps: { spawn?: CompactSpawn; list?: CompactModelLister } = {},
): Promise<string[]> {
  if (deps.list) return deps.list(provider, cfg);
  const spawn = deps.spawn ?? bunCompactSpawn;
  const argv = modelListArgv(provider, cfg);
  try {
    const child = spawn(argv, {});
    const [stdout, stderr, code] = await Promise.all([
      readChildText(child.stdout),
      readChildText(child.stderr),
      child.exited,
    ]);
    const combined = `${stdout}\n${stderr}`;
    if (isCliAuthMessage(combined)) {
      throw new CompactCliError(cliAuthMessage(provider));
    }
    if (code !== 0 && !stdout.trim()) {
      throw new CompactCliError(cliMissingOrFailed(provider, combined || `exit ${code}`));
    }
    const ids = parseModelList(stdout, stderr);
    if (!ids.length) throw new CompactCliError(`${providerLabel(provider)} CLI não devolveu modelos.`);
    return ids;
  } catch (err) {
    if (err instanceof CompactCliError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (isCliMissingMessage(msg) || (err as { code?: string }).code === "ENOENT") {
      throw new CompactCliError(cliMissingMessage(provider, binOf(provider, cfg)));
    }
    if (isCliAuthMessage(msg)) throw new CompactCliError(cliAuthMessage(provider));
    throw new CompactCliError(cliMissingOrFailed(provider, msg));
  }
}

export async function cachedProviderModels(
  dir: string,
  provider: CompactProvider,
  cfg: NcliConfig,
  deps: { spawn?: CompactSpawn; list?: CompactModelLister; now?: number } = {},
): Promise<CompactModelCache> {
  const hit = loadModelCache(dir, provider, deps.now);
  if (hit) return hit;
  try {
    const models = await listProviderModels(provider, cfg, deps);
    const row: CompactModelCache = { provider, models, fetchedAt: deps.now ?? Date.now() };
    saveModelCache(dir, row);
    return row;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const row: CompactModelCache = { provider, models: [], fetchedAt: deps.now ?? Date.now(), error };
    saveModelCache(dir, row);
    return row;
  }
}

function modelListArgv(provider: CompactProvider, cfg: NcliConfig): string[] {
  switch (provider) {
    case "codex":
      return [cfg.codexBin, "models"];
    case "claude":
      return [cfg.claudeBin, "--list-models"];
    case "cursor":
      return [cfg.cursorBin, "--list-models"];
    default: {
      const _n: never = provider;
      return _n;
    }
  }
}

function binOf(provider: CompactProvider, cfg: NcliConfig): string {
  switch (provider) {
    case "codex":
      return cfg.codexBin;
    case "claude":
      return cfg.claudeBin;
    case "cursor":
      return cfg.cursorBin;
    default: {
      const _n: never = provider;
      return _n;
    }
  }
}

function providerLabel(provider: CompactProvider): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "cursor":
      return "Cursor";
    default: {
      const _n: never = provider;
      return _n;
    }
  }
}

export function cliMissingMessage(provider: CompactProvider, bin: string): string {
  return `${providerLabel(provider)} CLI não está instalado (${bin}).`;
}

export function cliAuthMessage(provider: CompactProvider): string {
  return `${providerLabel(provider)} CLI não está logado.`;
}

function cliMissingOrFailed(provider: CompactProvider, detail: string): string {
  return `${providerLabel(provider)} CLI falhou: ${detail}`;
}

function looksLikeModelId(id: string): boolean {
  if (id.length < 2 || id.length > 80) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(id)) return false;
  if (/^(usage|options|commands|help|model|models|list)$/i.test(id)) return false;
  return true;
}

function idsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    const ids: string[] = [];
    for (const item of value) {
      if (typeof item === "string" && looksLikeModelId(item)) ids.push(item);
      else if (item && typeof item === "object") {
        const rec = item as { id?: unknown; slug?: unknown; name?: unknown };
        const id = [rec.id, rec.slug, rec.name].find((v) => typeof v === "string" && looksLikeModelId(v));
        if (typeof id === "string") ids.push(id);
      }
    }
    return unique(ids);
  }
  if (value && typeof value === "object") {
    const rec = value as { models?: unknown; data?: unknown };
    if (Array.isArray(rec.models)) return idsFromUnknown(rec.models);
    if (Array.isArray(rec.data)) return idsFromUnknown(rec.data);
  }
  return [];
}

function unique(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
