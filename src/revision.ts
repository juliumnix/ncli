import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type NcliRevision = {
  sha: string;
  short: string;
};

const SHA = /^[0-9a-f]{7,40}$/i;

export function shortSha(sha: string): string {
  return sha.trim().slice(0, 7);
}

export function parseRevision(raw: string | undefined): NcliRevision | undefined {
  const sha = (raw ?? "").trim();
  if (!SHA.test(sha)) return undefined;
  return { sha, short: shortSha(sha) };
}

export function readGitHead(root: string): string | undefined {
  const proc = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return undefined;
  return proc.stdout.toString().trim() || undefined;
}

export function readRevisionFile(root: string): string | undefined {
  const path = join(root, ".ncli-revision");
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim() || undefined;
}

export function resolveRevision(
  root: string,
  env: Record<string, string | undefined> = process.env,
  extra: string[] = [],
  remoteSha?: string,
): NcliRevision {
  const fromEnv = parseRevision(env.NCLI_REVISION);
  if (fromEnv) return fromEnv;
  const fromGit = parseRevision(readGitHead(root));
  if (fromGit) return fromGit;
  const fromFile = parseRevision(readRevisionFile(root));
  if (fromFile) return fromFile;
  const fromBlobs = shaFromBlobs([
    root,
    process.cwd(),
    process.argv.join(" "),
    env.npm_package_resolved,
    env.npm_lifecycle_script,
    ...extra,
  ]);
  if (fromBlobs) return fromBlobs;
  const fromCache = parseRevision(readBunGithubCacheSha());
  if (fromCache) return fromCache;
  const fromRemote = parseRevision(remoteSha);
  if (fromRemote) return fromRemote;
  return { sha: "unknown", short: "unknown" };
}

export type LsRemoteResult = { exitCode: number; stdout: string };

export function fetchMainTip(opts: { lsRemote?: () => LsRemoteResult } = {}): string | undefined {
  const run = opts.lsRemote ?? defaultLsRemote;
  const proc = run();
  if (proc.exitCode !== 0) return undefined;
  try {
    return parseLsRemoteMain(proc.stdout);
  } catch {
    return undefined;
  }
}

function defaultLsRemote(): LsRemoteResult {
  const proc = Bun.spawnSync(
    ["git", "ls-remote", "https://github.com/juliumnix/ncli.git", "refs/heads/main"],
    { stdout: "pipe", stderr: "pipe" },
  );
  return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

export const NCLI_GITHUB = "github:juliumnix/ncli";

export function ncliSpecAt(sha: string): string {
  const id = sha.trim();
  if (!SHA.test(id)) throw new Error("need a commit sha from main");
  return `${NCLI_GITHUB}#${id}`;
}

export function parseLsRemoteMain(text: string): string {
  const lines = text.split("\n");
  const main = lines.find((row) => /\srefs\/heads\/main\s*$/.test(row));
  const head = lines.find((row) => /\sHEAD\s*$/.test(row));
  const sha = (main ?? head)?.split(/\s+/)[0] ?? "";
  if (!SHA.test(sha)) throw new Error("git ls-remote did not return the main tip");
  return sha;
}

export function parseShaFromPath(path: string): string | undefined {
  const m = path.match(/[0-9a-f]{40}/i);
  return m ? m[0].toLowerCase() : undefined;
}

export function parseShaFromGithubSpec(raw: string): string | undefined {
  const m = raw.match(/juliumnix\/ncli#([0-9a-f]{7,40})\b/i);
  return m ? m[1].toLowerCase() : undefined;
}

export function readBunGithubCacheSha(home = homedir()): string | undefined {
  const roots = [
    join(home, ".bun/install/cache/github.com/juliumnix"),
    join(home, ".bun/install/cache/github.com"),
  ];
  let best: { sha: string; mtime: number } | undefined;
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const sha = name.match(/^ncli@([0-9a-f]{40})$/i)?.[1]
        ?? name.match(/ncli@([0-9a-f]{40})/i)?.[1]
        ?? parseShaFromPath(name);
      if (!sha || sha.length !== 40) continue;
      let mtime = 0;
      try {
        mtime = statSync(join(dir, name)).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtime > best.mtime) best = { sha: sha.toLowerCase(), mtime };
    }
  }
  return best?.sha;
}

function shaFromBlobs(blobs: Array<string | undefined>): NcliRevision | undefined {
  for (const blob of blobs) {
    if (!blob) continue;
    const fromSpec = parseRevision(parseShaFromGithubSpec(blob));
    if (fromSpec) return fromSpec;
    const fromPath = parseRevision(parseShaFromPath(blob));
    if (fromPath) return fromPath;
  }
  return undefined;
}

export function documentedLaunch(sha: string): { env: { NCLI_REVISION: string }; argv: string[] } {
  const id = sha.trim();
  return { env: { NCLI_REVISION: id }, argv: ["bunx", ncliSpecAt(id)] };
}

export function documentedBunx(sha: string): string[] {
  return documentedLaunch(sha).argv;
}
