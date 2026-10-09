import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface WorktreeHandle {
  path: string;
  branch: string;
  repo: string;
}

export interface GitRunner {
  (args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export async function realGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

export async function addWorktree(
  repo: string,
  forkId: string,
  git: GitRunner = realGit,
  baseDir?: string,
): Promise<WorktreeHandle> {
  const absRepo = resolve(repo);
  const root = baseDir ?? join(absRepo, ".ncli", "wt");
  mkdirSync(root, { recursive: true });
  const path = join(root, forkId);
  const branch = `ncli/${forkId}`;
  if (existsSync(path)) {
    return { path, branch, repo: absRepo };
  }
  const result = await git(["worktree", "add", "-B", branch, path, "HEAD"], absRepo);
  if (result.code !== 0) {
    const retry = await git(["worktree", "add", "--force", path, "HEAD"], absRepo);
    if (retry.code !== 0) {
      throw new Error(`git worktree add failed: ${result.stderr || retry.stderr}`);
    }
  }
  return { path, branch, repo: absRepo };
}

export async function removeWorktree(
  handle: WorktreeHandle,
  git: GitRunner = realGit,
): Promise<void> {
  await git(["worktree", "remove", "--force", handle.path], handle.repo);
  await git(["branch", "-D", handle.branch], handle.repo);
  if (existsSync(handle.path)) rmSync(handle.path, { recursive: true, force: true });
}

export async function initTempRepo(prefix = "ncli-repo"): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const git = realGit;
  await git(["init"], dir);
  await git(["config", "user.email", "ncli@local"], dir);
  await git(["config", "user.name", "ncli"], dir);
  await Bun.write(join(dir, "README.md"), "# ncli test repo\n");
  await git(["add", "."], dir);
  await git(["commit", "-m", "init"], dir);
  return dir;
}
