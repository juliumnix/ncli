import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { NcliConfig } from "../config";
import { childEnv } from "../harness/child-env";
import { redactPath } from "../redact";
import { killProcessGroup, spawnHarness } from "./children";
import type { RunOpts } from "../harness/types";
import type { AcpAdapter, AcpUpdate } from "./types";
import { SessionHot, sessionKey } from "./hot";
import {
  debugSeat,
  DEFAULT_SESSION_CAP,
  fileBytes,
  formatSeatTrace,
  persistSeatId,
  persistSeatModel,
  readSeatId,
  resumeOrRotate,
  sessionCap,
  type SeatSessionPlan,
  type SeatTurnTrace,
  walkFiles,
} from "./session";

interface HotWaiter {
  proc: ReturnType<typeof Bun.spawn>;
  fingerprint: string;
  threadId: string;
  rotated: boolean;
  spawnAt: number;
  stderr: string;
}

export class CodexExecAdapter implements AcpAdapter {
  readonly id = "codex";
  lastTrace: SeatTurnTrace | null = null;
  private readonly table = new SessionHot<HotWaiter>();

  constructor(private readonly cfg: NcliConfig) {}

  async warm(opts: RunOpts): Promise<void> {
    await this.ensureWaiter(opts);
  }

  close(): void {
    for (const waiter of this.table.takeAll()) this.kill(waiter);
  }

  release(session: string): void {
    this.kill(this.table.take(sessionKey(session)));
  }

  async *run(opts: RunOpts): AsyncIterable<AcpUpdate> {
    const shown = this.cfg.codexModel || readCodexConfigModel();
    if (shown) yield { sessionUpdate: "model", model: shown };
    const key = sessionKey(opts.session);
    const { waiter, reused } = await this.ensureWaiter(opts);
    const trace: SeatTurnTrace = {
      seat: "codex",
      spawnAt: waiter.spawnAt,
      turnAt: performance.now(),
      sessionId: waiter.threadId,
      rotated: reused ? false : waiter.rotated,
      hot: reused,
    };
    writeCodexPrompt(waiter.proc, codexStdinPrompt(opts));
    const reader = waiter.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        if (opts.signal?.aborted) {
          this.release(key);
          break;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = parseCodexEvent(line);
          if (ev.threadId) {
            trace.sessionId = ev.threadId;
            persistSeatId(this.cfg.dataDir, opts.session ?? "main", "codex", ev.threadId);
          }
          if (ev.init && !trace.initAt) trace.initAt = performance.now();
          if (ev.token && !trace.firstTokenAt) trace.firstTokenAt = performance.now();
          for (const update of ev.updates) {
            if (update.sessionUpdate === "model") {
              persistSeatModel(this.cfg.dataDir, opts.session ?? "main", "codex", update.model);
            }
            yield update;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    const code = await waiter.proc.exited;
    this.table.dropIf(key, waiter);
    trace.resultAt = performance.now();
    this.lastTrace = trace;
    logCodexTrace(trace);
    if (!opts.signal?.aborted && code !== 0) {
      throw new Error(waiter.stderr.trim() || `codex exited ${code}`);
    }
  }

  private async ensureWaiter(opts: RunOpts): Promise<{ waiter: HotWaiter; reused: boolean }> {
    const plan = planCodexSession({
      dataDir: this.cfg.dataDir,
      name: opts.session ?? "main",
      resume: opts.resume,
    });
    const args = buildCodexArgs(this.cfg, opts, plan);
    const fp = liveFingerprint(this.cfg, opts, plan);
    const key = sessionKey(opts.session);
    const got = await this.table.acquire(key, fp, () => this.spawnWaiter(key, args, fp, plan, opts));
    return { waiter: got.hot, reused: got.reused };
  }

  private async spawnWaiter(
    key: string,
    args: string[],
    fingerprint: string,
    plan: SeatSessionPlan,
    opts: RunOpts,
  ): Promise<HotWaiter> {
    this.kill(this.table.take(key));
    const spawnAt = performance.now();
    const proc = spawnHarness(args, {
      cwd: opts.cwd ?? this.cfg.repo,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: childEnv(process.env, { allowAnthropicKey: false }),
    });
    const waiter: HotWaiter = {
      proc,
      fingerprint,
      threadId: plan.id,
      rotated: plan.rotated,
      spawnAt,
      stderr: "",
    };
    void drainStderr(proc.stderr, waiter);
    debugSeat(`codex spawn session=${plan.id || "new"}${plan.rotated ? " rotated" : ""} resume=${plan.resume}`);
    return waiter;
  }

  private kill(waiter: HotWaiter | undefined): void {
    if (!waiter) return;
    killProcessGroup(waiter.proc.pid);
  }
}

export function codexStdinPrompt(opts: RunOpts): string {
  return opts.system ? `${opts.system}\n\n${opts.prompt}` : opts.prompt;
}

export function buildCodexArgs(cfg: NcliConfig, opts: RunOpts, plan?: SeatSessionPlan): string[] {
  const args = [cfg.codexBin, "exec", "--json", "--skip-git-repo-check"];
  if (cfg.codexModel) args.push("--model", cfg.codexModel);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  for (const dir of opts.addDir ?? []) args.push("--add-dir", dir);
  if (plan?.resume && plan.id) args.push("resume", plan.id);
  args.push("-");
  return args;
}

export function planCodexSession(opts: {
  dataDir: string;
  name: string;
  resume?: boolean;
  capBytes?: number;
  sessionsDir?: string;
}): SeatSessionPlan {
  const existing = readSeatId(opts.dataDir, opts.name, "codex");
  const cap = opts.capBytes ?? sessionCap("NCLI_CODEX_SESSION_CAP", DEFAULT_SESSION_CAP);
  return resumeOrRotate({
    existing,
    resume: opts.resume,
    capBytes: cap,
    bytes: existing ? codexSessionBytes(existing, opts.sessionsDir) : 0,
  });
}

export function defaultCodexSessionsDir(): string {
  return process.env.NCLI_CODEX_SESSIONS?.trim() || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
}

export function codexSessionBytes(threadId: string, sessionsDir?: string): number {
  if (!threadId) return 0;
  const root = sessionsDir ?? defaultCodexSessionsDir();
  let found = 0;
  walkFiles(root, (abs) => {
    if (!abs.endsWith(".jsonl")) return;
    if (!abs.includes(threadId)) return;
    found = Math.max(found, fileBytes(abs));
  });
  return found;
}

export interface CodexEvent {
  updates: AcpUpdate[];
  threadId?: string;
  init: boolean;
  token: boolean;
}

export function parseCodexEvent(line: string): CodexEvent {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { updates: [], init: false, token: false };
  }
  const type = String(ev.type ?? ev.event ?? "");
  const threadId = pickThreadId(ev);
  const init = Boolean(threadId) || /session|thread\.started|turn\.started|model/i.test(type);
  const updates = parseCodexLine(line);
  const token = updates.some(
    (u) => u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk",
  );
  return { updates, threadId, init, token };
}

export function parseCodexLine(line: string): AcpUpdate[] {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = String(ev.type ?? ev.event ?? "");
  const item = (ev.item ?? ev.data ?? ev) as Record<string, unknown>;
  const model = pickModel(ev);
  const text = pickText(item) || pickText(ev);
  if (model && /session|thread|turn\.started|model/i.test(type)) {
    return [{ sessionUpdate: "model", model }];
  }
  if (/reason|thinking|agent_thought/i.test(type) && text) {
    return [{ sessionUpdate: "agent_thought_chunk", text }];
  }
  if (/agent_message|message|output_text|item.completed|agent.message/i.test(type) && text) {
    return [{ sessionUpdate: "agent_message_chunk", text }];
  }
  if (/tool|command/i.test(type)) {
    return [
      {
        sessionUpdate: "tool_call",
        toolCallId: String(item.id ?? type),
        title: String(item.type ?? item.name ?? type),
        rawInput: item,
      },
    ];
  }
  if (text) return [{ sessionUpdate: "agent_message_chunk", text }];
  return [];
}

function pickThreadId(ev: Record<string, unknown>): string | undefined {
  if (typeof ev.thread_id === "string" && ev.thread_id.trim()) return ev.thread_id.trim();
  for (const obj of [ev.thread, ev.session, ev.item, ev.data]) {
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as { id?: unknown; thread_id?: unknown };
    if (typeof rec.thread_id === "string" && rec.thread_id.trim()) return rec.thread_id.trim();
    if (typeof rec.id === "string" && rec.id.trim() && /thread|session/i.test(String(ev.type ?? ""))) {
      return rec.id.trim();
    }
  }
  return undefined;
}

function pickText(obj: Record<string, unknown>): string {
  for (const key of ["text", "output", "content", "message", "result"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function pickModel(ev: Record<string, unknown>): string {
  for (const obj of [ev, ev.item, ev.thread, ev.session, ev.data]) {
    if (!obj || typeof obj !== "object") continue;
    const model = (obj as { model?: unknown }).model;
    if (typeof model === "string" && model.trim()) return model.trim();
  }
  return "";
}

export function parseCodexConfigModel(toml: string): string | undefined {
  const line = toml.match(/^\s*model\s*=\s*(.+)$/m);
  if (!line) return undefined;
  const raw = line[1].trim().replace(/\s+#.*$/, "");
  const quoted = raw.match(/^["']([^"']+)["']$/);
  const id = (quoted?.[1] ?? raw).trim();
  return id || undefined;
}

export function defaultCodexConfigPath(): string {
  const dir = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(dir, "config.toml");
}

export type CodexConfigWarning = {
  code: "legacy-profile" | "stdio-ncli";
  path: string;
};

export function checkCodexConfig(path = defaultCodexConfigPath()): CodexConfigWarning[] {
  if (!existsSync(path)) return [];
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const warnings: CodexConfigWarning[] = [];
  const shown = redactPath(path);
  if (hasLegacyProfile(text)) warnings.push({ code: "legacy-profile", path: shown });
  if (hasStdioNcli(text)) warnings.push({ code: "stdio-ncli", path: shown });
  return warnings;
}

export function formatCodexConfigWarnings(warnings: CodexConfigWarning[]): string {
  return warnings
    .map((warning) => {
      switch (warning.code) {
        case "legacy-profile":
          return `Codex config ${warning.path} has a legacy profile. codex exec rejects that file, so a compactor that runs codex exec will pause.`;
        case "stdio-ncli":
          return `Codex config ${warning.path} defines mcp_servers.ncli as stdio with a command. NCLI injects an HTTP url on that key, and Codex rejects the mix. Remove that ncli command so the HTTP server can load.`;
        default: {
          const _never: never = warning.code;
          return _never;
        }
      }
    })
    .join("\n");
}

function tomlBodies(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const hash = raw.indexOf("#");
    const body = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (body) out.push(body);
  }
  return out;
}

function hasLegacyProfile(text: string): boolean {
  let section = "";
  for (const line of tomlBodies(text)) {
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1] ?? "";
      if (section === "profiles" || section.startsWith("profiles.")) return true;
      continue;
    }
    if (section === "" && /^profile\s*=/.test(line)) return true;
  }
  return false;
}

function hasStdioNcli(text: string): boolean {
  let section = "";
  for (const line of tomlBodies(text)) {
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1] ?? "";
      continue;
    }
    if (section !== "mcp_servers.ncli") continue;
    const match = /^command\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = (match[1] ?? "").trim();
    if (raw && raw !== '""' && raw !== "''") return true;
  }
  return false;
}

export function readCodexConfigModel(path = defaultCodexConfigPath()): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseCodexConfigModel(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function liveFingerprint(cfg: NcliConfig, opts: RunOpts, plan: SeatSessionPlan): string {
  return [
    cfg.codexBin,
    cfg.codexModel,
    ...(opts.extraArgs ?? []),
    ...(opts.addDir ?? []),
    opts.cwd ?? cfg.repo,
    plan.resume ? plan.id : "",
  ].join("\0");
}

function writeCodexPrompt(proc: ReturnType<typeof Bun.spawn>, text: string): void {
  const stdin = proc.stdin;
  if (!stdin || typeof stdin === "number") throw new Error("codex stdin is closed");
  stdin.write(text);
  stdin.end();
}

async function drainStderr(stream: ReadableStream<Uint8Array>, waiter: HotWaiter): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      waiter.stderr += decoder.decode(value, { stream: true });
    }
  } catch {
  } finally {
    reader.releaseLock();
  }
}

function logCodexTrace(trace: SeatTurnTrace): void {
  debugSeat(formatSeatTrace(trace));
}
