import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface WorktreeHandle {
  path: string;
  branch: string;
  repo: string;
  baseDir: string;
}

export interface GitRunner {
  (args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export async function realGit(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

function tempGitEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "ncli",
    GIT_AUTHOR_EMAIL: "ncli@local",
    GIT_COMMITTER_NAME: "ncli",
    GIT_COMMITTER_EMAIL: "ncli@local",
  };
}

export interface WorktreePolicy {
  detached: boolean;
  include: string;
}

export interface WorktreeStatus {
  dirty: boolean;
  unpushed: boolean;
  files: string[];
}

export interface ArchiveResult {
  ok: boolean;
  archived: boolean;
  blocked?: "dirty" | "unpushed";
  status: WorktreeStatus;
}

export function loadWorktreePolicy(repo: string): WorktreePolicy {
  const file = join(repo, ".ncli", "worktree.json");
  const fallback: WorktreePolicy = { detached: true, include: ".worktreeinclude" };
  if (!existsSync(file)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<WorktreePolicy>;
    return {
      detached: raw.detached !== false,
      include: typeof raw.include === "string" && raw.include.trim() ? raw.include.trim() : fallback.include,
    };
  } catch {
    return fallback;
  }
}

export async function addWorktree(
  repo: string,
  sparkId: string,
  git: GitRunner = realGit,
  baseDir?: string,
): Promise<WorktreeHandle> {
  const absRepo = resolve(repo);
  const policy = loadWorktreePolicy(absRepo);
  const root = baseDir ?? join(absRepo, ".ncli", "wt");
  mkdirSync(root, { recursive: true });
  const path = join(root, sparkId);
  const branch = `ncli/${sparkId}`;
  if (existsSync(path)) {
    return { path, branch, repo: absRepo, baseDir: root };
  }
  const args = policy.detached
    ? (["worktree", "add", "--detach", path, "HEAD"] as string[])
    : (["worktree", "add", "-B", branch, path, "HEAD"] as string[]);
  const result = await git(args, absRepo);
  if (result.code !== 0) {
    const retry = await git(["worktree", "add", "--force", "--detach", path, "HEAD"], absRepo);
    if (retry.code !== 0) {
      throw new Error(`git worktree add failed: ${result.stderr || retry.stderr}`);
    }
  }
  applyInclude(absRepo, path, policy.include);
  return { path, branch, repo: absRepo, baseDir: root };
}

export async function inspectWorktree(
  handle: WorktreeHandle,
  git: GitRunner = realGit,
): Promise<WorktreeStatus> {
  const porcelain = await git(["status", "--porcelain"], handle.path);
  const files = porcelain.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.slice(3).trim());
  const unpushed = await aheadOfUpstream(handle, git);
  return { dirty: files.length > 0, unpushed, files };
}

export async function upstreamRef(handle: WorktreeHandle, git: GitRunner = realGit): Promise<string | null> {
  const tracked = await git(["rev-parse", "--abbrev-ref", "@{upstream}"], handle.path);
  if (tracked.code === 0 && tracked.stdout.trim()) return tracked.stdout.trim();
  const origin = await git(["rev-parse", "--verify", `origin/${handle.branch}`], handle.path);
  if (origin.code === 0) return `origin/${handle.branch}`;
  return null;
}

async function aheadOfUpstream(handle: WorktreeHandle, git: GitRunner): Promise<boolean> {
  const upstream = await upstreamRef(handle, git);
  const base = upstream ?? (await git(["rev-parse", "HEAD"], handle.repo)).stdout.trim();
  if (!base) return false;
  const extra = await git(["rev-list", "--count", `${base}..HEAD`], handle.path);
  if (extra.code !== 0) return true;
  const n = Number.parseInt(extra.stdout.trim(), 10);
  return Number.isFinite(n) && n > 0;
}

export async function archiveWorktree(
  handle: WorktreeHandle,
  git: GitRunner = realGit,
  opts: { force?: boolean } = {},
): Promise<ArchiveResult> {
  const status = existsSync(handle.path)
    ? await inspectWorktree(handle, git)
    : { dirty: false, unpushed: false, files: [] };
  if (!opts.force && status.dirty) {
    return { ok: false, archived: false, blocked: "dirty", status };
  }
  if (!opts.force && status.unpushed) {
    return { ok: false, archived: false, blocked: "unpushed", status };
  }
  await removeWorktree(handle, git);
  return { ok: true, archived: true, status };
}

export async function removeWorktree(
  handle: WorktreeHandle,
  git: GitRunner = realGit,
): Promise<void> {
  await git(["worktree", "remove", "--force", handle.path], handle.repo);
  await git(["branch", "-D", handle.branch], handle.repo);
  if (existsSync(handle.path)) rmSync(handle.path, { recursive: true, force: true });
}

export function applyInclude(repo: string, dest: string, includeFile: string): void {
  const listed = join(repo, includeFile);
  if (!existsSync(listed)) return;
  const lines = readFileSync(listed, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.includes(".."));
  for (const rel of lines) {
    const from = join(repo, rel);
    if (!existsSync(from)) continue;
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

export async function initTempRepo(prefix = "ncli-repo"): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const env = tempGitEnv();
  const git = (args: string[]) => realGit(args, dir, env);
  await git(["init"]);
  await git(["config", "user.email", "ncli@local"]);
  await git(["config", "user.name", "ncli"]);
  await git(["config", "commit.gpgsign", "false"]);
  await git(["config", "core.fsmonitor", "false"]);
  await Bun.write(join(dir, "README.md"), "# ncli test repo\n");
  await git(["add", "."]);
  await git(["commit", "-m", "init"]);
  return dir;
}
