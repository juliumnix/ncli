import { homedir } from "node:os";
import { join } from "node:path";
import { parseFallbackChain } from "./harness/usage";
import { packageRoot } from "./pkg-root";

export type HarnessKind = "claude" | "cursor" | "codex" | "mock" | "auto";
export type CompactBackend = "cursor" | "claude" | "mock" | "auto";

export interface NcliConfig {
  dataDir: string;
  port: number;
  livePort: number;
  host: string;
  harness: HarnessKind;
  demo: boolean;
  nodeBytes: number;
  viewBytes: number;
  compactJobs: number;
  compactTries: number;
  compactBackend: CompactBackend;
  compactModel: string;
  compactSkipTokens: number;
  compactBatch: number;
  compactDebounceMs: number;
  compactBudgetTokens: number;
  compactMaxInputTokens: number;
  compactSettleMs: number;
  compactTimeoutMs: number;
  toolCap: number;
  repo: string;
  ghMode: "real" | "mock" | "auto";
  claudeBin: string;
  claudeModel: string;
  claudeApiKey: boolean;
  cursorBin: string;
  cursorModel: string;
  acpCursor: string;
  codexBin: string;
  codexModel: string;
  busDepth: number;
  busChildren: number;
  busBudget: number;
  ncliRoot: string;
  pkgRoot: string;
  backupHarness: HarnessKind;
  fallbackChain: HarnessKind[];
  userName: string;
  importClaude: string;
  importCodex: string;
  importCursor: string;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function millis(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function optionalPositive(name: string): number {
  const v = process.env[name];
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function hasCompactDailyBudget(n: number): boolean {
  return n > 0;
}

export const DEFAULT_COMPACT_MODEL = "composer-2.5";

export function parseCursorModel(raw: string | undefined): string {
  const id = (raw ?? "").trim();
  return id || "composer-2.5";
}

export function parseCompactModel(raw: string | undefined): string {
  const id = (raw ?? "").trim();
  return id || DEFAULT_COMPACT_MODEL;
}

export function parseCodexModel(raw: string | undefined): string {
  return (raw ?? "").trim();
}

export function parseUserName(raw: string | undefined): string {
  const name = (raw ?? "").trim();
  return name || "Você";
}

export function dataRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return env.NCLI_ROOT ?? cwd;
}

export function loadConfig(overrides: Partial<NcliConfig> = {}): NcliConfig {
  const harnessEnv = (process.env.NCLI_HARNESS ?? "auto") as HarnessKind;
  const ghEnv = (process.env.NCLI_GH ?? "auto") as NcliConfig["ghMode"];
  const compactEnv = (process.env.NCLI_COMPACT ?? "auto") as CompactBackend;
  const {
    cursorModel: cursorOverride,
    compactModel: compactOverride,
    codexModel: codexOverride,
    userName: userNameOverride,
    ...rest
  } = overrides;
  return {
    dataDir: process.env.NCLI_DATA ?? join(process.cwd(), "data"),
    port: num("NCLI_PORT", 47231),
    livePort: Math.max(0, Number(process.env.NCLI_LIVE_PORT ?? 0) || 0),
    host: process.env.NCLI_HOST ?? "0.0.0.0",
    harness: harnessEnv,
    demo: process.env.NCLI_DEMO === "1",
    nodeBytes: num("NCLI_NODE", 280),
    viewBytes: num("NCLI_VIEW", 2500),
    compactJobs: num("NCLI_JOBS", 6),
    compactTries: num("NCLI_TRIES", 3),
    compactBackend: compactEnv,
    compactModel: parseCompactModel(compactOverride ?? process.env.NCLI_COMPACT_MODEL),
    compactSkipTokens: num("NCLI_COMPACT_SKIP", 80),
    compactBatch: num("NCLI_COMPACT_BATCH", 200),
    compactDebounceMs: num("NCLI_COMPACT_DEBOUNCE", 2500),
    compactBudgetTokens: optionalPositive("NCLI_COMPACT_DAILY_BUDGET"),
    compactMaxInputTokens: num("NCLI_COMPACT_MAX_INPUT", 60_000),
    compactSettleMs: millis("NCLI_COMPACT_SETTLE", 0),
    compactTimeoutMs: millis("NCLI_COMPACT_TIMEOUT", 120_000),
    toolCap: num("NCLI_CAP", 8000),
    repo: process.env.NCLI_REPO ?? process.cwd(),
    ghMode: ghEnv,
    claudeBin: process.env.NCLI_CLAUDE ?? "claude",
    claudeModel: process.env.NCLI_CLAUDE_MODEL ?? "",
    claudeApiKey: process.env.NCLI_CLAUDE_API_KEY === "1",
    cursorBin: process.env.NCLI_CURSOR ?? "cursor-agent",
    cursorModel: parseCursorModel(cursorOverride ?? process.env.NCLI_CURSOR_MODEL),
    acpCursor: process.env.NCLI_ACP_CURSOR ?? "cursor-agent acp",
    codexBin: process.env.NCLI_CODEX ?? "codex",
    codexModel: parseCodexModel(codexOverride ?? process.env.NCLI_CODEX_MODEL),
    busDepth: num("NCLI_BUS_DEPTH", 1),
    busChildren: num("NCLI_BUS_CHILDREN", 4),
    busBudget: num("NCLI_BUS_BUDGET", 8),
    ncliRoot: dataRoot(),
    pkgRoot: packageRoot(),
    backupHarness: (process.env.NCLI_BACKUP ?? "codex") as HarnessKind,
    fallbackChain: parseFallbackChain(process.env.NCLI_FALLBACK, (process.env.NCLI_BACKUP ?? "codex") as HarnessKind),
    userName: parseUserName(userNameOverride ?? process.env.NCLI_USER_NAME),
    importClaude: process.env.NCLI_IMPORT_CLAUDE ?? "",
    importCodex: process.env.NCLI_IMPORT_CODEX ?? "",
    importCursor: process.env.NCLI_IMPORT_CURSOR ?? "",
    ...rest,
  };
}

export function personalDataDir(): string {
  return join(homedir(), ".ncli");
}
