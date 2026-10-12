import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planShip, runShip } from "../src/sparks/ship";
import { addWorktree, initTempRepo, inspectWorktree, realGit, type GitRunner } from "../src/sparks/worktree";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

async function attachOrigin(wtPath: string): Promise<string> {
  const bare = join(tmpdir(), `ncli-origin-${crypto.randomUUID()}`);
  mkdirSync(bare, { recursive: true });
  await realGit(["init", "--bare"], bare);
  await realGit(["remote", "add", "origin", bare], wtPath);
  return bare;
}

test("planShip is commit, then PR, then idle", () => {
  expect(planShip({ dirty: true, unpushed: false, files: ["a.ts"] }, " card ")).toEqual({
    kind: "commit",
    label: "commit e PR",
    title: "card",
    files: ["a.ts"],
  });
  expect(planShip({ dirty: false, unpushed: true, files: [] }, "card").kind).toBe("open-pr");
  expect(planShip({ dirty: false, unpushed: false, files: [] }, "card").kind).toBe("idle");
});

test("client paints a one-click ship button from the plan", () => {
  expect(appJs).toContain("function bindShip");
  expect(appJs).toContain("function shipSpark");
  expect(appJs).toContain("/ship");
  expect(appJs).toContain("ship-go");
  expect(appJs).toContain("aria-busy");
  expect(appJs).toContain("shipping.has");
});

test("runShip commits dirty files and opens a PR", async () => {
  const repo = await initTempRepo("ship-dirty");
  const wt = await addWorktree(repo, "spark-ship");
  await Bun.write(join(wt.path, "card.ts"), "export const n = 1;\n");
  const calls: string[] = [];
  const git: GitRunner = async (args, cwd) => {
    calls.push(args[0] ?? "");
    if (args[0] === "push") return { stdout: "ok", stderr: "", code: 0 };
    return realGit(args, cwd);
  };
  const result = await runShip({
    handle: wt,
    title: "card do checkout",
    git,
    openPr: async ({ title, head }) => {
      expect(title).toBe("card do checkout");
      expect(head).toBe(wt.branch);
      return { url: "https://github.com/ncli/ncli/pull/9" };
    },
  });
  expect(result.ok).toBe(true);
  expect(result.url).toBe("https://github.com/ncli/ncli/pull/9");
  expect(calls).toContain("commit");
  expect(calls).toContain("push");
  const status = await inspectWorktree(wt, realGit);
  expect(status.dirty).toBe(false);
});

test("runShip on a clean ahead worktree only opens the PR", async () => {
  const repo = await initTempRepo("ship-ahead");
  const wt = await addWorktree(repo, "spark-ahead");
  await Bun.write(join(wt.path, "note.md"), "local\n");
  await realGit(["add", "note.md"], wt.path);
  await realGit(["commit", "-m", "wip"], wt.path);
  const calls: string[] = [];
  const git: GitRunner = async (args, cwd) => {
    calls.push(args.join(" "));
    if (args[0] === "push") return { stdout: "ok", stderr: "", code: 0 };
    return realGit(args, cwd);
  };
  const result = await runShip({
    handle: wt,
    title: "wip",
    git,
    openPr: async () => ({ url: "https://github.com/ncli/ncli/pull/2" }),
  });
  expect(result.ok).toBe(true);
  expect(result.plan.kind).toBe("open-pr");
  expect(calls.some((c) => c.startsWith("commit"))).toBe(false);
  expect(result.url).toBe("https://github.com/ncli/ncli/pull/2");
});

test("inspectWorktree counts unpushed against origin, so a shipped branch is idle", async () => {
  const repo = await initTempRepo("ship-upstream");
  const wt = await addWorktree(repo, "spark-up");
  await attachOrigin(wt.path);
  await Bun.write(join(wt.path, "note.md"), "local\n");
  await realGit(["add", "note.md"], wt.path);
  await realGit(["commit", "-m", "wip"], wt.path);
  await realGit(["checkout", "-B", wt.branch], wt.path);
  expect((await inspectWorktree(wt)).unpushed).toBe(true);
  expect(planShip(await inspectWorktree(wt), "wip").kind).toBe("open-pr");
  await realGit(["push", "-u", "origin", wt.branch], wt.path);
  const after = await inspectWorktree(wt);
  expect(after.unpushed).toBe(false);
  expect(after.dirty).toBe(false);
  expect(planShip(after, "wip").kind).toBe("idle");
});

test("runShip reuses an open PR and ignores a second click", async () => {
  const repo = await initTempRepo("ship-once");
  const wt = await addWorktree(repo, "spark-once");
  await attachOrigin(wt.path);
  await Bun.write(join(wt.path, "card.ts"), "export const n = 1;\n");
  let creates = 0;
  let found: { url: string } | null = null;
  const openPr = async () => {
    creates += 1;
    found = { url: "https://github.com/ncli/ncli/pull/4" };
    return found;
  };
  const opts = {
    handle: wt,
    title: "card",
    git: realGit,
    openPr,
    findPr: async () => found,
  };
  const [a, b] = await Promise.all([runShip(opts), runShip(opts)]);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  expect(a.url).toBe("https://github.com/ncli/ncli/pull/4");
  expect(b.url).toBe("https://github.com/ncli/ncli/pull/4");
  expect(creates).toBe(1);
  const again = await runShip(opts);
  expect(again.ok).toBe(true);
  expect(again.plan.kind).toBe("idle");
  expect(creates).toBe(1);
  expect(planShip(await inspectWorktree(wt), "card").kind).toBe("idle");
});

test("runShip returns the existing PR instead of creating another", async () => {
  const repo = await initTempRepo("ship-view");
  const wt = await addWorktree(repo, "spark-view");
  await Bun.write(join(wt.path, "note.md"), "local\n");
  await realGit(["add", "note.md"], wt.path);
  await realGit(["commit", "-m", "wip"], wt.path);
  let creates = 0;
  const git: GitRunner = async (args, cwd) => {
    if (args[0] === "push") return { stdout: "ok", stderr: "", code: 0 };
    return realGit(args, cwd);
  };
  const first = await runShip({
    handle: wt,
    title: "wip",
    git,
    openPr: async () => {
      creates += 1;
      return { url: "https://github.com/ncli/ncli/pull/7" };
    },
    findPr: async () => (creates ? { url: "https://github.com/ncli/ncli/pull/7" } : null),
  });
  expect(first.url).toBe("https://github.com/ncli/ncli/pull/7");
  const second = await runShip({
    handle: wt,
    title: "wip",
    git,
    openPr: async () => {
      creates += 1;
      return { url: "https://github.com/ncli/ncli/pull/8" };
    },
    findPr: async () => ({ url: "https://github.com/ncli/ncli/pull/7" }),
  });
  expect(second.ok).toBe(true);
  expect(second.url).toBe("https://github.com/ncli/ncli/pull/7");
  expect(creates).toBe(1);
});
