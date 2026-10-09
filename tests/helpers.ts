import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { Hub } from "../src/hub";
import { MockHarness } from "../src/harness/mock";
import type { Harness } from "../src/harness/types";
import { initTempRepo } from "../src/forks/worktree";

export function tmpDir(prefix = "ncli"): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export async function makeHub<H extends Harness = MockHarness>(opts: {
  viewsDir?: string;
  harness?: H;
  demo?: boolean;
  viewBytes?: number;
  nodeBytes?: number;
} = {}): Promise<{ hub: Hub; repo: string; dataDir: string; harness: H }> {
  const dataDir = tmpDir("ncli-data");
  const repo = await initTempRepo();
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
  });
  const hub = new Hub(
    cfg,
    opts.viewsDir ?? join(import.meta.dir, "../views"),
    join(import.meta.dir, "../fixtures/gh"),
    harness,
  );
  await hub.start();
  return { hub, repo, dataDir, harness };
}

export async function waitUntil(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await Bun.sleep(30);
  }
  throw new Error("timeout");
}
