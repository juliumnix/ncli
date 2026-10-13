import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type HarnessKind } from "../src/config";
import { parseFallbackChain } from "../src/harness/usage";
import type { GhClient } from "../src/gh/pr";
import { Hub } from "../src/hub";
import { MockHarness } from "../src/harness/mock";
import type { Harness } from "../src/harness/types";
import { initTempRepo } from "../src/sparks/worktree";

export function tmpDir(prefix = "ncli"): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export function shotsDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.NCLI_SHOTS?.trim();
  if (fromEnv) return fromEnv;
  return join(tmpdir(), "ncli-shots");
}

export async function makeHub<H extends Harness = MockHarness>(opts: {
  viewsDir?: string;
  harness?: H;
  demo?: boolean;
  viewBytes?: number;
  nodeBytes?: number;
  backupHarness?: HarnessKind;
  fallbackChain?: HarnessKind[];
  importClaude?: string;
  importCodex?: string;
  importCursor?: string;
  compactSkipTokens?: number;
  repo?: string;
  dataDir?: string;
  gh?: GhClient;
} = {}): Promise<{ hub: Hub; repo: string; dataDir: string; harness: H }> {
  const dataDir = opts.dataDir ?? tmpDir("ncli-data");
  const repo = opts.repo ?? await initTempRepo();
  const importEmpty = tmpDir("ncli-import-empty");
  const harness = (opts.harness ?? new MockHarness()) as H;
  const cfg = loadConfig({
    dataDir,
    repo,
    ncliRoot: join(import.meta.dir, ".."),
    harness: "mock",
    demo: opts.demo ?? false,
    ghMode: "mock",
    viewBytes: opts.viewBytes ?? 800,
    nodeBytes: opts.nodeBytes ?? 140,
    port: 47231,
    backupHarness: opts.backupHarness ?? "mock",
    fallbackChain: opts.fallbackChain ?? parseFallbackChain(undefined, opts.backupHarness ?? "mock"),
    importClaude: opts.importClaude ?? importEmpty,
    importCodex: opts.importCodex ?? importEmpty,
    importCursor: opts.importCursor ?? importEmpty,
    ...(opts.compactSkipTokens !== undefined ? { compactSkipTokens: opts.compactSkipTokens } : {}),
  });
  const hub = new Hub(
    cfg,
    opts.viewsDir ?? join(import.meta.dir, "../views"),
    join(import.meta.dir, "../fixtures/gh"),
    harness,
    undefined,
    opts.gh,
  );
  await hub.start();
  hub.offerFirstImport();
  return { hub, repo, dataDir, harness };
}

export async function waitUntil(fn: () => boolean | Promise<boolean>, ms = 8000, what = "timeout"): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await Bun.sleep(30);
  }
  throw new Error(what);
}
