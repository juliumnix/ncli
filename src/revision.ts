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
  return { sha: "unknown", short: "unknown" };
}

export const NCLI_GITHUB_TIP = "https://api.github.com/repos/juliumnix/ncli/commits/main";

export function parseGithubCommitSha(raw: string | undefined): string | undefined {
  const text = (raw ?? "").trim();
  if (!text) return undefined;
  if (!text.startsWith("{")) return parseRevision(text)?.sha;
  try {
    const json: unknown = JSON.parse(text);
    if (!json || typeof json !== "object") return undefined;
    const sha = (json as { sha?: unknown }).sha;
    return typeof sha === "string" ? parseRevision(sha)?.sha : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchMainTip(opts: { get?: () => Promise<string | undefined> } = {}): Promise<string | undefined> {
  try {
    const raw = opts.get ? await opts.get() : await defaultGithubTip();
    return parseGithubCommitSha(raw);
  } catch {
    return undefined;
  }
}

export function readyBannerSha(pin: string, live: string | undefined): string {
  return parseRevision(pin)?.sha ?? parseRevision(live)?.sha ?? pin;
}

export function testedRevision(
  env: Record<string, string | undefined> = process.env,
  head?: string,
): string | undefined {
  return parseRevision(env.NCLI_REVISION)?.sha
    ?? parseRevision(env.GITHUB_SHA)?.sha
    ?? parseRevision(head)?.sha;
}

export function readBootRevision(
  root: string,
  env: Record<string, string | undefined> = process.env,
  extra: string[] = [],
): NcliRevision {
  return resolveRevision(root, env, extra);
}

async function defaultGithubTip(): Promise<string | undefined> {
  const res = await fetch(NCLI_GITHUB_TIP, {
    headers: {
      Accept: "application/vnd.github.sha",
      "User-Agent": "ncli",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return undefined;
  return await res.text();
}

export const NCLI_GITHUB = "github:juliumnix/ncli";

export function ncliSpecAt(sha: string): string {
  const id = sha.trim();
  if (!SHA.test(id)) throw new Error("need a commit sha from main");
  return `${NCLI_GITHUB}#${id}`;
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
