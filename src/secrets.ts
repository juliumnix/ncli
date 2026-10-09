import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const NCLI_SECRETS_REL = join(".config", "ncli", "secrets.env");
export const COMPACT_SDK_KEY = "NCLI_CURSOR_API_KEY";

const FROM_FILE = new Set([COMPACT_SDK_KEY]);

export function ncliSecretsPath(home = homedir()): string {
  return join(home, NCLI_SECRETS_REL);
}

export function parseSecretsEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!FROM_FILE.has(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return out;
}

export function loadNcliSecrets(
  env: Record<string, string | undefined> = process.env,
  home = env.HOME || homedir(),
): { path: string; loaded: boolean; mode?: number } {
  const path = ncliSecretsPath(home);
  if (!existsSync(path)) return { path, loaded: false };
  const mode = statSync(path).mode & 0o777;
  const parsed = parseSecretsEnv(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    const cur = env[key];
    if (cur === undefined || cur === "") env[key] = value;
  }
  return { path, loaded: true, mode };
}

export function compactSdkKey(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[COMPACT_SDK_KEY]?.trim();
  return value || undefined;
}

export function missingCompactKeyMessage(secretsPath = ncliSecretsPath()): string {
  return [
    "NCLI compaction uses the official Cursor SDK (@cursor/sdk), not cursor-agent.",
    `Set ${COMPACT_SDK_KEY} in ${secretsPath} (chmod 600) or in the process environment.`,
    "Mint a user key at https://cursor.com/dashboard/cloud-agents.",
    "NCLI never reads CURSOR_API_KEY, ~/.cursor, or the interactive CLI default.",
  ].join(" ");
}

export function redactSecrets(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  const key = compactSdkKey(env);
  if (key) out = out.split(key).join("***");
  return out;
}
