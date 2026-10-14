import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GhClient } from "../src/gh/pr";
import { loadConfig } from "../src/config";
import { MockHarness } from "../src/harness/mock";
import { SparkManager, type SparkManagerHooks } from "../src/sparks/manager";
import { initTempRepo, type GitRunner } from "../src/sparks/worktree";
import { ViewRegistry } from "../src/views/registry";
import { makeHub, tmpDir, waitUntil } from "./helpers";

const gh: GhClient = {
  async view(pr: string) {
    return { number: Number(pr) || 1, title: "t", body: "", files: [], diff: "" };
  },
};

function managerFor(
  repo: string,
  dataDir: string,
  views: ViewRegistry,
  harness: MockHarness,
  extra: { git?: GitRunner; worktreeBase?: string; harnessFor?: (id: string) => MockHarness | undefined } = {},
) {
  const cfg = loadConfig({
    dataDir,
    repo,
    ncliRoot: join(import.meta.dir, ".."),
    harness: "mock",
    compactBackend: "mock",
    ghMode: "mock",
  });
  const hooks: SparkManagerHooks = {
    onEvent() {},
    onMerge() {},
    compressor: async () => "",
    harness,
    git: extra.git,
    worktreeBase: extra.worktreeBase,
    harnessFor: extra.harnessFor,
  };
  return new SparkManager(cfg, views, gh, hooks);
}

async function isoViews(root: string): Promise<{ views: ViewRegistry; skills: string }> {
  const pack = join(root, "iso");
  const skills = join(pack, "skills");
  mkdirSync(join(skills, "only"), { recursive: true });
  writeFileSync(join(skills, "only", "SKILL.md"), "---\ndescription: only this pack\n---\n\n# only\n");
  writeFileSync(
    join(pack, "manifest.json"),
    JSON.stringify({
      name: "iso",
      version: "1.0.0",
      description: "isolation fixture",
      requires: { harnesses: ["codex", "mock"] },
      agents: [{ id: "lead", role: "lead", harness: "codex" }],
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
  return { views, skills };
}

test("a spark runs on the flow agent's harness and receives only that pack's skill dirs", async () => {
  const repo = await initTempRepo("iso-agent");
  const dataDir = tmpDir("iso-agent-data");
  const { views, skills } = await isoViews(join(dataDir, "views"));
  const main = new MockHarness();
  const codex = new MockHarness(() => ({ text: "parecer do codex" }), "codex");
  const mgr = managerFor(repo, dataDir, views, main, {
    harnessFor: (id) => (id === "codex" ? codex : undefined),
  });
  const rt = await mgr.open("iso", { card: "alpha" });
  await waitUntil(() => codex.lastPrompts.length + main.lastPrompts.length > 0, 2000);
  expect(codex.lastAddDirs[0]).toEqual([skills]);
  expect(codex.lastPrompts.some((p) => p.includes("iso prompt"))).toBe(true);
  expect(codex.lastSystems.some((s) => s.includes(rt.spark.id))).toBe(true);
  expect(main.lastPrompts).toEqual([]);
  expect(main.lastAddDirs).toEqual([]);
  views.close();
});

test("a view that asks for a worktree fails visibly when git worktree add fails", async () => {
  const repo = await initTempRepo("iso-wt-fail");
  const dataDir = tmpDir("iso-wt-fail-data");
  const { views } = await isoViews(join(dataDir, "views"));
  const harness = new MockHarness(() => ({ text: "nao devia rodar" }));
  const mgr = managerFor(repo, dataDir, views, harness, {
    git: async () => ({ code: 1, stdout: "", stderr: "boom" }),
  });
  let thrown = "";
  try {
    await mgr.open("iso", { card: "alpha", wt: "1" });
  } catch (err) {
    thrown = (err as Error).message;
  }
  expect(thrown).toContain("git worktree add failed: boom");
  const failed = mgr.list().find((s) => s.view === "iso");
  expect(failed?.status).toBe("error");
  expect(failed?.summary).toContain("boom");
  expect(mgr.get(failed!.id)?.worktree).toBeUndefined();
  const ok = await mgr.open("iso", { card: "beta" });
  await waitUntil(() => harness.lastSystems.some((s) => s.includes(ok.spark.id)));
  expect(harness.lastSystems.some((s) => s.includes(failed!.id))).toBe(false);
  expect(harness.lastCwds).toEqual([repo]);
  views.close();
});

test("open after close keeps the spark id, rebuilds the worktree, and runs again", async () => {
  const repo = await initTempRepo("iso-find");
  const dataDir = tmpDir("iso-find-data");
  const { views } = await isoViews(join(dataDir, "views"));
  const harness = new MockHarness(() => ({ text: "rodou" }));
  const mgr = managerFor(repo, dataDir, views, harness);
  const first = await mgr.open("iso", { card: "same", wt: "1" });
  await mgr.close(first.spark.id);
  expect(first.spark.status).toBe("merged");
  const second = await mgr.open("iso", { card: "same", wt: "1" });
  expect(second.spark.id).toBe(first.spark.id);
  expect(second.spark.status).toBe("running");
  expect(existsSync(second.worktree?.path ?? "")).toBe(true);
  await waitUntil(() => harness.lastSystems.some((s) => s.includes(second.spark.id)));
  expect(harness.lastCwds).toContain(second.worktree!.path);
  views.close();
});

test("reopen after close builds a new worktree and runs again", async () => {
  const repo = await initTempRepo("iso-reopen");
  const dataDir = tmpDir("iso-reopen-data");
  const base = join(dataDir, "wt-base");
  const { views } = await isoViews(join(dataDir, "views"));
  const harness = new MockHarness(() => ({ text: "rodou" }));
  const mgr = managerFor(repo, dataDir, views, harness, { worktreeBase: base });
  const first = await mgr.open("iso", { card: "same", wt: "1" });
  expect(first.worktree?.path).toBe(join(base, first.spark.id));
  expect(existsSync(first.worktree!.path)).toBe(true);
  await mgr.close(first.spark.id);
  expect(first.spark.status).toBe("merged");
  const second = await mgr.open("iso", { card: "same", wt: "1" });
  expect(second.spark.id).toBe(first.spark.id);
  expect(second.spark.status).toBe("running");
  expect(second.worktree?.path).toBe(join(base, first.spark.id));
  expect(existsSync(second.worktree!.path)).toBe(true);
  await waitUntil(() => harness.lastSystems.some((s) => s.includes(second.spark.id)));
  expect(harness.lastCwds).toContain(second.worktree!.path);
  views.close();
});

test("restore uses the stored worktree base and ignores a missing path or a file", async () => {
  const repo = await initTempRepo("iso-restore");
  const dataDir = tmpDir("iso-restore-data");
  const base = join(dataDir, "wt-base");
  const { views } = await isoViews(join(dataDir, "views"));
  const harness = new MockHarness();
  const mgr = managerFor(repo, dataDir, views, harness, { worktreeBase: base });
  const opened = await mgr.open("iso", { card: "keep", wt: "1" });
  const livePath = join(base, opened.spark.id);
  expect(opened.worktree?.path).toBe(livePath);
  expect(existsSync(livePath)).toBe(true);
  const next = managerFor(repo, dataDir, views, new MockHarness(), { worktreeBase: base });
  next.restore();
  expect(next.get(opened.spark.id)?.worktree?.path).toBe(livePath);

  const ghostId = "iso-ghost";
  const home = join(dataDir, "sparks", ghostId);
  mkdirSync(home, { recursive: true });
  const filePath = join(repo, ".ncli", "wt", ghostId);
  mkdirSync(join(repo, ".ncli", "wt"), { recursive: true });
  writeFileSync(filePath, "not a directory");
  writeFileSync(
    join(home, "meta.json"),
    JSON.stringify({
      id: ghostId,
      seq: 9,
      view: "iso",
      title: "ghost",
      status: "running",
      params: { card: "ghost", wt: "1" },
      createdAt: "2026-01-01T00:00:00.000Z",
      worktree: `wt/${ghostId}`,
      branch: `ncli/${ghostId}`,
      repo,
    }),
  );
  const again = managerFor(repo, dataDir, views, new MockHarness(), { worktreeBase: base });
  again.restore();
  expect(again.get(ghostId)?.worktree).toBeUndefined();
  expect(again.get(opened.spark.id)?.worktree?.path).toBe(livePath);
  views.close();
});

test("finish releases the spark session process", async () => {
  const repo = await initTempRepo("iso-release");
  const dataDir = tmpDir("iso-release-data");
  const { views } = await isoViews(join(dataDir, "views"));
  const released: string[] = [];
  const harness = new MockHarness(() => ({ text: "ok" }));
  harness.release = (session: string) => {
    released.push(session);
  };
  const mgr = managerFor(repo, dataDir, views, harness);
  const rt = await mgr.open("iso", { card: "hold" });
  await waitUntil(() => harness.lastSystems.some((s) => s.includes(rt.spark.id)));
  await mgr.finish(rt.spark.id, "fim");
  expect(rt.spark.status).toBe("merged");
  expect(released).toEqual([rt.spark.id]);
  views.close();
});

test("finish persists a restored fork in forks and does not copy it into sparks", async () => {
  const { hub, dataDir } = await makeHub();
  const dir = join(dataDir, "forks", "team-9");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      id: "team-9",
      seq: 9,
      view: "team",
      title: "team",
      status: "needs_user",
      params: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  hub.sparks.restore();
  await hub.sparks.finish("team-9", "feito");
  const saved = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { status: string; summary: string };
  expect(saved.status).toBe("merged");
  expect(saved.summary).toBe("feito");
  expect(existsSync(join(dataDir, "sparks", "team-9", "meta.json"))).toBe(false);
  hub.close();
});
