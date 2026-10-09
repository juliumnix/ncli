import { homedir } from "node:os";
import { join } from "node:path";

export type HarnessKind = "claude" | "cursor" | "codex" | "mock" | "auto";
export type CompactBackend = "cursor" | "claude" | "mock" | "auto";

export interface NcliConfig {
  dataDir: string;
  port: number;
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
  pstackCodex: string;
  pstackCursor: string;
  fanout: boolean;
  busDepth: number;
  busChildren: number;
  busBudget: number;
  ncliRoot: string;
  backupHarness: HarnessKind;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(overrides: Partial<NcliConfig> = {}): NcliConfig {
  const harnessEnv = (process.env.NCLI_HARNESS ?? "auto") as HarnessKind;
  const ghEnv = (process.env.NCLI_GH ?? "auto") as NcliConfig["ghMode"];
  const compactEnv = (process.env.NCLI_COMPACT ?? "auto") as CompactBackend;
  return {
    dataDir: process.env.NCLI_DATA ?? join(process.cwd(), "data"),
    port: num("NCLI_PORT", 47231),
    host: process.env.NCLI_HOST ?? "0.0.0.0",
    harness: harnessEnv,
    demo: process.env.NCLI_DEMO === "1",
    nodeBytes: num("NCLI_NODE", 280),
    viewBytes: num("NCLI_VIEW", 2500),
    compactJobs: num("NCLI_JOBS", 4),
    compactTries: num("NCLI_TRIES", 3),
    compactBackend: compactEnv,
    compactModel: process.env.NCLI_COMPACT_MODEL ?? "claude-haiku-5-5-low",
    compactSkipTokens: num("NCLI_COMPACT_SKIP", 80),
    compactBatch: num("NCLI_COMPACT_BATCH", 6),
    compactDebounceMs: num("NCLI_COMPACT_DEBOUNCE", 2500),
    compactBudgetTokens: num("NCLI_COMPACT_BUDGET", 250000),
    compactMaxInputTokens: num("NCLI_COMPACT_MAX_INPUT", 60_000),
    toolCap: num("NCLI_CAP", 8000),
    repo: process.env.NCLI_REPO ?? process.cwd(),
    ghMode: ghEnv,
    claudeBin: process.env.NCLI_CLAUDE ?? "claude",
    claudeModel: process.env.NCLI_CLAUDE_MODEL ?? "",
    claudeApiKey: process.env.NCLI_CLAUDE_API_KEY === "1",
    cursorBin: process.env.NCLI_CURSOR ?? "cursor-agent",
    cursorModel: process.env.NCLI_CURSOR_MODEL ?? "composer-2.5",
    acpCursor: process.env.NCLI_ACP_CURSOR ?? "cursor-agent acp",
    codexBin: process.env.NCLI_CODEX ?? "codex",
    codexModel: process.env.NCLI_CODEX_MODEL ?? "gpt-5.4",
    pstackCodex: process.env.NCLI_PSTACK_CODEX ?? "pstack-codex",
    pstackCursor: process.env.NCLI_PSTACK_CURSOR ?? "pstack-cursor",
    fanout: process.env.NCLI_FANOUT === "1",
    busDepth: num("NCLI_BUS_DEPTH", 1),
    busChildren: num("NCLI_BUS_CHILDREN", 4),
    busBudget: num("NCLI_BUS_BUDGET", 8),
    ncliRoot: process.env.NCLI_ROOT ?? process.cwd(),
    backupHarness: (process.env.NCLI_BACKUP ?? "codex") as HarnessKind,
    ...overrides,
  };
}

export function personalDataDir(): string {
  return join(homedir(), ".ncli");
}
