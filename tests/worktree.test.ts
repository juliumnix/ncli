import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  addWorktree,
  archiveWorktree,
  initTempRepo,
  inspectWorktree,
  loadWorktreePolicy,
  realGit,
} from "../src/sparks/worktree";

test("addWorktree is detached by default and copies include files", async () => {
  const repo = await initTempRepo("wt-add");
  await Bun.write(join(repo, ".env.local"), "SECRET=1\n");
  await Bun.write(join(repo, ".worktreeinclude"), ".env.local\n");
  const wt = await addWorktree(repo, "spark-1");
  const head = await realGit(["rev-parse", "--abbrev-ref", "HEAD"], wt.path);
  expect(head.stdout.trim()).toBe("HEAD");
  expect(existsSync(join(wt.path, ".env.local"))).toBe(true);
  expect(loadWorktreePolicy(repo).detached).toBe(true);
});

test("dirty worktree blocks archive until force", async () => {
  const repo = await initTempRepo("wt-dirty");
  const wt = await addWorktree(repo, "spark-dirty");
  await Bun.write(join(wt.path, "scratch.txt"), "wip\n");
  const status = await inspectWorktree(wt);
  expect(status.dirty).toBe(true);
  expect(status.files.some((f) => f.includes("scratch.txt"))).toBe(true);
  const blocked = await archiveWorktree(wt);
  expect(blocked.ok).toBe(false);
  expect(blocked.blocked).toBe("dirty");
  expect(existsSync(wt.path)).toBe(true);
  const gone = await archiveWorktree(wt, realGit, { force: true });
  expect(gone.ok).toBe(true);
  expect(existsSync(wt.path)).toBe(false);
});

test("local commits block archive as unpushed", async () => {
  const repo = await initTempRepo("wt-ahead");
  const wt = await addWorktree(repo, "spark-ahead");
  await Bun.write(join(wt.path, "note.md"), "local\n");
  await realGit(["add", "note.md"], wt.path);
  await realGit(["commit", "-m", "wip"], wt.path);
  const status = await inspectWorktree(wt);
  expect(status.unpushed).toBe(true);
  const blocked = await archiveWorktree(wt);
  expect(blocked.ok).toBe(false);
  expect(blocked.blocked).toBe("unpushed");
  expect(existsSync(wt.path)).toBe(true);
});

test(".ncli/worktree.json can keep a named branch", async () => {
  const repo = await initTempRepo("wt-branch");
  mkdirSync(join(repo, ".ncli"), { recursive: true });
  await Bun.write(join(repo, ".ncli", "worktree.json"), JSON.stringify({ detached: false }));
  const wt = await addWorktree(repo, "spark-br");
  const head = await realGit(["rev-parse", "--abbrev-ref", "HEAD"], wt.path);
  expect(head.stdout.trim()).toBe("ncli/spark-br");
});
