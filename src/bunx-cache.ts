import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { documentedLaunch, parseRevision } from "./revision";

export type LaunchMainOpts = {
  tmpDirs?: string[];
  uid?: number;
};

export type LaunchPlan = {
  argv: string[];
  env: { NCLI_REVISION: string };
  removed: string[];
};

export function bunxTmpCandidates(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out: string[] = [];
  const tmpdir = (env.TMPDIR ?? "").replace(/\/+$/, "");
  if (tmpdir) out.push(tmpdir);
  if (!out.includes("/tmp")) out.push("/tmp");
  if (platform === "darwin" && !out.includes("/private/tmp")) out.push("/private/tmp");
  return out;
}

export function ncliExtractPrefix(uid: number): string {
  return `bunx-${uid}-ncli@github@`;
}

export function listNcliBunxExtracts(dirs: string[], uid: number): string[] {
  const prefix = ncliExtractPrefix(uid);
  const found: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(prefix)) found.push(join(dir, name));
    }
  }
  return found;
}

export function ncliExtractName(path: string, uid: number): string | undefined {
  const prefix = ncliExtractPrefix(uid);
  return path.split("/").find((part) => part.startsWith(prefix));
}

export function clearNcliBunxExtracts(dirs: string[], uid: number, liveExtract?: string): string[] {
  const skip = liveExtract ? ncliExtractName(liveExtract, uid) : undefined;
  const removed: string[] = [];
  const seen = new Set<string>();
  for (const dir of listNcliBunxExtracts(dirs, uid)) {
    const name = ncliExtractName(dir, uid);
    if (!name || name === skip || seen.has(name)) continue;
    seen.add(name);
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

export function launchMain(sha: string, opts: LaunchMainOpts = {}): LaunchPlan {
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  const tmpDirs = opts.tmpDirs ?? bunxTmpCandidates();
  const removed = clearNcliBunxExtracts(tmpDirs, uid);
  return { ...documentedLaunch(sha), removed };
}

export function bunxExtractRoot(path: string, uid: number): string | undefined {
  const name = ncliExtractName(path, uid);
  if (!name) return undefined;
  const parts = path.split("/");
  return parts.slice(0, parts.indexOf(name) + 1).join("/");
}

function sameSha(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

export type BunxRefreshPlan =
  | { kind: "boot" }
  | { kind: "reexec"; argv: string[]; env: { NCLI_REVISION: string }; removed: string[] };

export function planBunxRefresh(opts: {
  runningPath: string;
  env: Record<string, string | undefined>;
  uid: number;
  remoteSha?: string;
  tmpDirs?: string[];
}): BunxRefreshPlan {
  const extract = bunxExtractRoot(opts.runningPath, opts.uid);
  if (!extract) return { kind: "boot" };
  const remote = parseRevision(opts.remoteSha);
  if (!remote) return { kind: "boot" };
  const pinned = parseRevision(opts.env.NCLI_REVISION);
  if (pinned && sameSha(pinned.sha, remote.sha)) return { kind: "boot" };
  const tmpDirs = opts.tmpDirs ?? bunxTmpCandidates(opts.env);
  const removed = clearNcliBunxExtracts(tmpDirs, opts.uid, extract);
  return { kind: "reexec", ...documentedLaunch(remote.sha), removed };
}
