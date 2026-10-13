import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { documentedLaunch } from "./revision";

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

export function clearNcliBunxExtracts(dirs: string[], uid: number): string[] {
  const removed: string[] = [];
  for (const dir of listNcliBunxExtracts(dirs, uid)) {
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
