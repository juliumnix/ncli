import type { NcliConfig } from "../config";
import { childEnv } from "../harness/child-env";
import { MASTER, VIEW_DOC } from "./assemble";
import { codexMcpFlags } from "../mcp/inject";
import { loadMcpRegistry, resolveServers, spawnVars } from "../mcp/registry";
import { skillPrompt } from "../skills/catalog";
import { flattenLine, utf8Bytes } from "../util";
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
  COMPACT_CHILD_TIMEOUT_MS,
  isolatedCompactCwd,
  readChildText,
  type CompactChild,
  type CompactProcTiming,
  type CompactSpawn,
} from "./compact-proc";

export { isolatedCompactCwd };

export const COMPACT_TOO_LONG_TRIES = 5;
export const sizeRuler = utf8Bytes;

export function rulerBar(limit: number): string {
  return "-".repeat(Math.max(0, limit));
}

export type CliCompactDeps = {
  spawn?: CompactSpawn;
  pool?: CompactProcPool;
  env?: Record<string, string | undefined>;
  onTiming?: (row: CompactProcTiming & { provider: CompactProvider }) => void;
  shareChat?: boolean;
  mcpNames?: string[];
  timeoutMs?: number;
};

export const CODEX_ISOLATE_C = [
  "project_doc_max_bytes=0",
  'instructions=""',
  'developer_instructions=""',
] as const;

export const CODEX_DISABLE_FEATURES = [
  "shell_tool",
  "unified_exec",
  "unified_exec_tty",
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "sleep_tool",
  "view_image",
  "skill_search",
  "plugins",
  "web_search_request",
  "web_search_cached",
  "standalone_web_search",
  "in_app_browser",
  "in_app_local_automation",
  "multi_agent",
  "hooks",
] as const;

export function compactSharesChat(provider: CompactProvider, harness: string): boolean {
  return harness === provider;
}

export function chatSystemPrompt(): string {
  return [MASTER, skillPrompt(), VIEW_DOC].filter(Boolean).join("\n\n");
}

export function compactAsk(prompt: string, shareChat: boolean): string {
  return shareChat ? `${chatSystemPrompt()}\n\n${prompt}` : prompt;
}

export function mcpListArgv(bin: string): string[] {
  return [bin, "mcp", "list", "--json"];
}

export function parseMcpList(stdout: string): string[] {
  const json = parseLeadingJson(stdout);
  return json === undefined ? [] : mcpNamesFromUnknown(json);
}

function parseLeadingJson(text: string): unknown {
  const start = text.search(/[\[{]/);
  if (start < 0) return undefined;
  const slice = text.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    for (let i = slice.length; i > 1; i--) {
      const ch = slice[i - 1];
      if (ch !== "]" && ch !== "}") continue;
      try {
        return JSON.parse(slice.slice(0, i));
      } catch {
        continue;
      }
    }
    return undefined;
  }
}

export function isolateCodexFlags(mcpNames: string[]): string[] {
  const flags = ["--skip-git-repo-check", "--sandbox", "read-only"];
  for (const name of mcpNames) {
    if (!name) continue;
    flags.push("-c", `mcp_servers.${name}.enabled=false`);
  }
  for (const feat of CODEX_DISABLE_FEATURES) flags.push("--disable", feat);
  for (const key of CODEX_ISOLATE_C) flags.push("-c", key);
  return flags;
}

export async function withTooLong(
  run: (prompt: string, model: string) => Promise<string>,
  prompt: string,
  model: string,
  tooLong: (reply: string) => boolean,
): Promise<string> {
  let ask = prompt;
  let last = "";
  for (let i = 0; i < COMPACT_TOO_LONG_TRIES; i++) {
    last = await run(ask, model);
    if (!last.trim() || !tooLong(last)) return last;
    ask = `Too long.\n${prompt}`;
  }
  return last;
}

export function cliCompactArgv(
  provider: CompactProvider,
  cfg: NcliConfig,
  model: string,
  prompt: string,
  opts: { shareChat?: boolean; mcpNames?: string[] } = {},
): string[] {
  switch (provider) {
    case "codex": {
      const args = [cfg.codexBin, "exec", "--json"];
      if (opts.shareChat) {
        args.push(...codexMcpFlags(resolveServers(loadMcpRegistry(cfg.ncliRoot), spawnVars(cfg, "compact"))));
      } else {
        args.push(...isolateCodexFlags(opts.mcpNames ?? []));
      }
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

export async function listCodexMcpNames(
  bin: string,
  spawn: CompactSpawn,
  env: Record<string, string>,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<string[]> {
  const child = spawn(mcpListArgv(bin), env, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    readChildText(child.stdout),
    readChildText(child.stderr),
    child.exited,
  ]);
  const names = parseMcpList(stdout);
  if (code !== 0 && !names.length) {
    throw new CompactCliError(`Codex CLI falhou: mcp list ${stderr.trim() || `exit ${code}`}`);
  }
  return names;
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
  const shareChat = Boolean(deps.shareChat);
  const cwd = shareChat ? undefined : isolatedCompactCwd(cfg.dataDir);
  const timeoutMs = deps.timeoutMs ?? cfg.compactTimeoutMs ?? COMPACT_CHILD_TIMEOUT_MS;
  let mcpNames = deps.mcpNames;
  if (provider === "codex" && !shareChat && !mcpNames) {
    mcpNames = await listCodexMcpNames(cfg.codexBin, spawn, env, { cwd, timeoutMs: 15_000 });
  }
  await pool.acquire();
  const argv = cliCompactArgv(provider, cfg, model, prompt, { shareChat, mcpNames });
  const t0 = Date.now();
  let child: CompactChild;
  try {
    child = spawn(argv, env, cwd ? { cwd, timeoutMs } : { timeoutMs });
  } catch (err) {
    throw classifyCliError(provider, cfg, err);
  }
  const spawnMs = Date.now() - t0;
  const pid = child.pid || pool.allocPid();
  pool.track(pid, () => child.kill(), timeoutMs);
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

function mcpNamesFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueNames(value.map(mcpNameOf).filter(Boolean));
  }
  if (value && typeof value === "object") {
    const rec = value as { servers?: unknown; mcp_servers?: unknown };
    if (Array.isArray(rec.servers)) return mcpNamesFromUnknown(rec.servers);
    if (Array.isArray(rec.mcp_servers)) return mcpNamesFromUnknown(rec.mcp_servers);
  }
  return [];
}

function mcpNameOf(item: unknown): string {
  if (typeof item === "string") return item.trim();
  if (item && typeof item === "object") {
    const rec = item as { name?: unknown };
    return typeof rec.name === "string" ? rec.name.trim() : "";
  }
  return "";
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
