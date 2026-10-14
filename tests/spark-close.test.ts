import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GhClient } from "../src/gh/pr";
import { loadConfig } from "../src/config";
import type { Harness, HarnessEvent, RunOpts } from "../src/harness/types";
import { SparkManager } from "../src/sparks/manager";
import { initTempRepo } from "../src/sparks/worktree";
import { ViewRegistry } from "../src/views/registry";
import { tmpDir, waitUntil } from "./helpers";

const gh: GhClient = {
  async view() {
    return { number: 1, title: "t", body: "", files: [], diff: "" };
  },
};

class ProcHarness implements Harness {
  readonly id = "mock";
  readonly procs = new Map<string, ReturnType<typeof Bun.spawn>>();
  readonly spawned: Array<ReturnType<typeof Bun.spawn>> = [];

  async *run(opts: RunOpts): AsyncIterable<HarnessEvent> {
    const key = opts.session ?? "main";
    if (!this.procs.has(key)) {
      const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      this.procs.set(key, proc);
      this.spawned.push(proc);
    }
    yield { type: "done", text: "ok" };
  }

  release(session: string): void {
    const proc = this.procs.get(session);
    this.procs.delete(session);
    try {
      proc?.kill();
    } catch {
      /* already gone */
    }
  }

  close(): void {
    for (const id of [...this.procs.keys()]) this.release(id);
  }
}

async function isoViews(root: string): Promise<ViewRegistry> {
  const pack = join(root, "iso");
  mkdirSync(join(pack, "skills", "only"), { recursive: true });
  writeFileSync(join(pack, "skills", "only", "SKILL.md"), "---\ndescription: only\n---\n\n# only\n");
  writeFileSync(
    join(pack, "manifest.json"),
    JSON.stringify({
      name: "iso",
      version: "1.0.0",
      description: "close fixture",
      requires: { harnesses: ["mock"] },
      agents: [{ id: "lead", role: "lead", harness: "mock" }],
      skills: ["skills"],
      flow: [
        { id: "spark", title: "Brief", agent: "lead", kind: "spark", next: "result" },
        { id: "result", title: "Return", agent: "lead", kind: "result" },
      ],
    }),
  );
  writeFileSync(
    join(pack, "view.ts"),
    `const plugin = {
  id: "iso",
  label: "iso",
  description: "iso",
  tabs: [],
  async createSpark(params, ctx) {
    return {
      title: params.card ?? "iso",
      prompt: "iso prompt",
      needsWorktree: params.wt === "1",
      repo: ctx.repo,
      hold: true,
      flowStep: "spark",
    };
  },
};
export default plugin;
`,
  );
  const views = new ViewRegistry(root);
  await views.loadAll();
  return views;
}

test("closing three sparks without ack leaves no live process and no extra worktree", async () => {
  const repo = await initTempRepo("iso-close");
  const dataDir = tmpDir("iso-close-data");
  const base = join(dataDir, "wt-base");
  const views = await isoViews(join(dataDir, "views"));
  const harness = new ProcHarness();
  const cfg = loadConfig({
    dataDir,
    repo,
    ncliRoot: join(import.meta.dir, ".."),
    harness: "mock",
    compactBackend: "mock",
    ghMode: "mock",
  });
  const mgr = new SparkManager(cfg, views, gh, {
    onEvent() {},
    onMerge() {},
    compressor: async () => "",
    harness,
    worktreeBase: base,
  });
  try {
    const opened = [];
    for (const card of ["a", "b", "c"]) {
      opened.push(await mgr.open("iso", { card, wt: "1" }));
    }
    await waitUntil(() => harness.spawned.length === 3);
    expect(new Set(opened.map((rt) => rt.spark.id)).size).toBe(3);
    const paths = opened.map((rt) => rt.worktree?.path ?? "");
    expect(paths.every((p) => existsSync(p))).toBe(true);

    for (const rt of opened) await mgr.close(rt.spark.id);

    expect(harness.procs.size).toBe(0);
    await Promise.all(harness.spawned.map((proc) => proc.exited));
    expect(harness.spawned.every((proc) => proc.exitCode !== null || proc.signalCode !== null)).toBe(true);
    expect(paths.every((p) => !existsSync(p))).toBe(true);
    const left = existsSync(base) ? readdirSync(base) : [];
    expect(left).toEqual([]);
  } finally {
    harness.close();
    views.close();
  }
});
