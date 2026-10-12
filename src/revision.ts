import { existsSync, readFileSync } from "node:fs";
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
): NcliRevision {
  const fromEnv = parseRevision(env.NCLI_REVISION);
  if (fromEnv) return fromEnv;
  const fromGit = parseRevision(readGitHead(root));
  if (fromGit) return fromGit;
  const fromFile = parseRevision(readRevisionFile(root));
  if (fromFile) return fromFile;
  const fromPath = parseRevision(parseShaFromPath(root));
  if (fromPath) return fromPath;
  return { sha: "unknown", short: "unknown" };
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

export function documentedLaunch(sha: string): { env: { NCLI_REVISION: string }; argv: string[] } {
  const id = sha.trim();
  return { env: { NCLI_REVISION: id }, argv: ["bunx", ncliSpecAt(id)] };
}

export function documentedBunx(sha: string): string[] {
  return documentedLaunch(sha).argv;
}
