import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planShip, runShip } from "../src/sparks/ship";
import { addWorktree, initTempRepo, inspectWorktree, realGit, type GitRunner } from "../src/sparks/worktree";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

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
  expect(status.unpushed).toBe(true);
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
