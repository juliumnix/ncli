import { flattenLine } from "../util";
import type { NcliConfig } from "../config";
import { childEnv } from "../harness/child-env";
import type { CompactProvider } from "./compact-choice";
import {
  CompactCliError,
  isCliAuthMessage,
  isCliMissingMessage,
  isProviderLimitMessage,
  ProviderLimitError,
} from "./compact-deferred";
import { cliAuthMessage, cliMissingMessage } from "./compact-models";
import {
  bunCompactSpawn,
  CompactProcPool,
  readChildText,
  type CompactChild,
  type CompactProcTiming,
  type CompactSpawn,
} from "./compact-proc";

export const COMPACT_RULER = 512;
export const COMPACT_TOO_LONG_TRIES = 5;

export type CliCompactDeps = {
  spawn?: CompactSpawn;
  pool?: CompactProcPool;
  env?: Record<string, string | undefined>;
  onTiming?: (row: CompactProcTiming & { provider: CompactProvider }) => void;
};

export function cliCompactArgv(provider: CompactProvider, cfg: NcliConfig, model: string, prompt: string): string[] {
  switch (provider) {
    case "codex": {
      const args = [cfg.codexBin, "exec", "--json"];
      if (model) args.push("--model", model);
      args.push(prompt);
      return args;
    }
    case "claude": {
      const args = [cfg.claudeBin, "-p", "--output-format", "stream-json", "--verbose"];
      if (model) args.push("--model", model);
      args.push(prompt);
      return args;
    }
    case "cursor": {
      const args = [cfg.cursorBin, "--print", "--output-format", "json", "--trust"];
      if (model) args.push("--model", model);
      args.push(prompt);
      return args;
    }
    default: {
      const _n: never = provider;
      return _n;
    }
  }
}

export function parseCliCompactOutput(provider: CompactProvider, stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  switch (provider) {
    case "codex":
      return parseCodexExec(trimmed);
    case "claude":
      return parseClaudeStream(trimmed);
    case "cursor":
      return parseCursorPrint(trimmed);
    default: {
      const _n: never = provider;
      return _n;
    }
  }
}

export async function runCliCompact(
  provider: CompactProvider,
  cfg: NcliConfig,
  prompt: string,
  model: string,
  deps: CliCompactDeps = {},
): Promise<string> {
  const pool = deps.pool ?? new CompactProcPool();
  const spawn = deps.spawn ?? bunCompactSpawn;
  const env = childEnv(deps.env ?? process.env);
  await pool.acquire();
  const argv = cliCompactArgv(provider, cfg, model, prompt);
  const t0 = Date.now();
  let child: CompactChild;
  try {
    child = spawn(argv, env);
  } catch (err) {
    throw classifyCliError(provider, cfg, err);
  }
  const spawnMs = Date.now() - t0;
  const pid = child.pid || pool.allocPid();
  pool.track(pid, () => child.kill());
  try {
    const [stdout, stderr, code] = await Promise.all([
      readChildText(child.stdout),
      readChildText(child.stderr),
      child.exited,
    ]);
    const modelMs = Date.now() - t0 - spawnMs;
    deps.onTiming?.({ pid, spawnMs, modelMs, provider });
    const combined = `${stdout}\n${stderr}`;
    if (isProviderLimitMessage(combined)) throw new ProviderLimitError(combined.trim());
    if (isCliAuthMessage(combined)) throw new CompactCliError(cliAuthMessage(provider));
    if (code !== 0 && !stdout.trim()) throw classifyCliError(provider, cfg, new Error(stderr.trim() || `exit ${code}`));
    const text = parseCliCompactOutput(provider, stdout);
    if (!text) throw new CompactCliError(`${provider} CLI devolveu texto vazio.`);
    return text;
  } finally {
    pool.release(pid);
  }
}

export function classifyCliError(provider: CompactProvider, cfg: NcliConfig, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code;
  if (isProviderLimitMessage(msg)) return new ProviderLimitError(msg);
  if (isCliAuthMessage(msg)) return new CompactCliError(cliAuthMessage(provider));
  if (code === "ENOENT" || isCliMissingMessage(msg)) {
    const bin = provider === "codex" ? cfg.codexBin : provider === "claude" ? cfg.claudeBin : cfg.cursorBin;
    return new CompactCliError(cliMissingMessage(provider, bin));
  }
  return err instanceof Error ? err : new Error(msg);
}

function parseCodexExec(stdout: string): string {
  const lines = stdout.split("\n").filter(Boolean);
  let last = "";
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      const type = String(ev.type ?? ev.event ?? "");
      const item = (ev.item ?? ev.data ?? ev) as Record<string, unknown>;
      const text = pickText(item) || pickText(ev);
      if (text && /agent_message|message|output_text|item.completed|agent.message|result/i.test(type)) {
        last = text;
      }
      if (typeof ev.result === "string" && ev.result.trim()) last = ev.result.trim();
    } catch {
      if (!line.startsWith("{")) last = line;
    }
  }
  return flattenLine(last || stdout);
}

function parseClaudeStream(stdout: string): string {
  const lines = stdout.split("\n").filter(Boolean);
  let last = "";
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      const type = String(ev.type ?? "");
      if (type === "result" && typeof ev.result === "string") last = ev.result;
      const text = pickText(ev);
      if (text && /result|assistant|text|message/i.test(type)) last = text;
    } catch {
      if (!line.startsWith("{")) last = line;
    }
  }
  return flattenLine(last || stdout);
}

function parseCursorPrint(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["result", "text", "message", "response"]) {
      const v = json[key];
      if (typeof v === "string" && v.trim()) return flattenLine(v);
    }
  } catch {
    const last = trimmed.split("\n").filter(Boolean).at(-1) ?? "";
    try {
      const json = JSON.parse(last) as Record<string, unknown>;
      if (typeof json.result === "string") return flattenLine(json.result);
    } catch {
      return flattenLine(trimmed.split("\n").filter((l) => !l.startsWith("{")).join(" ") || trimmed);
    }
  }
  return flattenLine(trimmed);
}

function pickText(rec: Record<string, unknown>): string {
  for (const key of ["text", "message", "result", "output_text", "content"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
