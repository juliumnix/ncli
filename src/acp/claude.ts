import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NcliConfig } from "../config";
import { childEnv } from "../harness/child-env";
import type { RunOpts } from "../harness/types";
import type { AcpAdapter, AcpUpdate } from "./types";
import { persistSeatModel, readSeatModel } from "./session";

export const DEFAULT_CLAUDE_SESSION_CAP = 256 * 1024;

export interface ClaudeSessionPlan {
  id: string;
  resume: boolean;
  rotated: boolean;
}

export interface ClaudeTurnTrace {
  spawnAt: number;
  turnAt: number;
  initAt?: number;
  firstTokenAt?: number;
  resultAt?: number;
  sessionId: string;
  rotated: boolean;
  hot: boolean;
}

interface StreamLine {
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      content?: unknown;
      tool_use_id?: string;
    }>;
  };
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
    content_block?: { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> };
  };
  result?: string;
}

class LinePump {
  private q: string[] = [];
  private wait: ((v: string | null) => void) | null = null;
  closed = false;
  private buf = "";
  private readonly decoder = new TextDecoder();

  constructor(stream: ReadableStream<Uint8Array>) {
    void this.loop(stream);
  }

  private async loop(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.buf += this.decoder.decode(value, { stream: true });
        const lines = this.buf.split("\n");
        this.buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) this.push(line);
        }
      }
    } finally {
      reader.releaseLock();
      this.close();
    }
  }

  private push(line: string): void {
    if (this.wait) {
      const w = this.wait;
      this.wait = null;
      w(line);
      return;
    }
    this.q.push(line);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.wait) {
      this.wait(null);
      this.wait = null;
    }
  }

  next(): Promise<string | null> {
    if (this.q.length) return Promise.resolve(this.q.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.wait = resolve;
    });
  }
}

interface HotProc {
  proc: ReturnType<typeof Bun.spawn>;
  fingerprint: string;
  sessionId: string;
  rotated: boolean;
  spawnAt: number;
  pump: LinePump;
  stderr: string;
}

export class ClaudeCliAdapter implements AcpAdapter {
  readonly id = "claude";
  lastTrace: ClaudeTurnTrace | null = null;
  private hot: HotProc | null = null;
  private opening: Promise<HotProc> | null = null;

  constructor(private readonly cfg: NcliConfig) {}

  async warm(opts: RunOpts): Promise<void> {
    await this.ensureHot(opts);
  }

  close(): void {
    this.killHot();
  }

  async *run(opts: RunOpts): AsyncIterable<AcpUpdate> {
    const { hot, reused } = await this.ensureHot(opts);
    const trace: ClaudeTurnTrace = {
      spawnAt: hot.spawnAt,
      turnAt: performance.now(),
      sessionId: hot.sessionId,
      rotated: reused ? false : hot.rotated,
      hot: reused,
    };
    writeClaudeUser(hot.proc, opts.prompt);
    const fold = newClaudeFold();
    try {
      while (true) {
        if (opts.signal?.aborted) {
          this.killHot();
          break;
        }
        const line = await hot.pump.next();
        if (line == null) {
          const code = await hot.proc.exited;
          this.hot = null;
          throw new Error(hot.stderr.trim() || `claude exited ${code}`);
        }
        const kind = lineKind(line);
        if (kind === "system" && !trace.initAt) {
          trace.initAt = performance.now();
          for (const update of parseClaudeLine(line)) {
            if (update.sessionUpdate === "model") persistClaudeModel(this.cfg.dataDir, opts.session ?? "main", update.model);
          }
        }
        if (!trace.firstTokenAt && isTokenLine(line)) trace.firstTokenAt = performance.now();
        yield* foldClaudeLine(fold, line);
        if (kind === "result") {
          trace.resultAt = performance.now();
          break;
        }
      }
    } finally {
      this.lastTrace = trace;
      logClaudeTrace(trace);
    }
  }

  private async ensureHot(opts: RunOpts): Promise<{ hot: HotProc; reused: boolean }> {
    const { args, plan } = claudeSpawn(this.cfg, opts);
    const sessionId = plan?.id ?? sessionIdOf(args);
    const fp = liveFingerprint(this.cfg, opts, sessionId);
    if (this.hot && this.hot.fingerprint === fp && this.hot.proc.exitCode === null) {
      return { hot: this.hot, reused: true };
    }
    if (this.opening) {
      const hot = await this.opening;
      return { hot, reused: this.hot === hot && hot.fingerprint === fp };
    }
    this.opening = this.spawnHot(args, fp, sessionId, plan?.rotated ?? false, opts);
    try {
      this.hot = await this.opening;
      return { hot: this.hot, reused: false };
    } finally {
      this.opening = null;
    }
  }

  private async spawnHot(
    args: string[],
    fingerprint: string,
    sessionId: string,
    rotated: boolean,
    opts: RunOpts,
  ): Promise<HotProc> {
    this.killHot();
    const spawnAt = performance.now();
    const proc = Bun.spawn(args, {
      cwd: opts.cwd ?? this.cfg.repo,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: childEnv(process.env, { allowAnthropicKey: this.cfg.claudeApiKey }),
    });
    const hot: HotProc = {
      proc,
      fingerprint,
      sessionId,
      rotated,
      spawnAt,
      pump: new LinePump(proc.stdout),
      stderr: "",
    };
    void drainStderr(proc.stderr, hot);
    this.hot = hot;
    debugClaude(`claude spawn session=${sessionId}${rotated ? " rotated" : ""} args=${args.length}`);
    return hot;
  }

  private killHot(): void {
    const hot = this.hot;
    this.hot = null;
    if (!hot) return;
    try {
      const stdin = hot.proc.stdin;
      if (stdin && typeof stdin !== "number") stdin.end();
    } catch {}
    try {
      hot.proc.kill();
    } catch {}
    hot.pump.close();
  }
}

export function claudeUserLine(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

export function claudeSpawn(cfg: NcliConfig, opts: RunOpts): { args: string[]; plan?: ClaudeSessionPlan } {
  const args = [
    cfg.claudeBin,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--input-format",
    "stream-json",
  ];
  if (opts.model ?? cfg.claudeModel) args.push("--model", opts.model ?? cfg.claudeModel);
  if (opts.mcpConfigPath) {
    args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
    if (!opts.extraArgs?.includes("--allowedTools")) args.push("--allowedTools", "mcp__ncli__*");
  }
  for (const dir of opts.addDir ?? []) args.push("--add-dir", dir);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  let plan: ClaudeSessionPlan | undefined;
  if (opts.session) {
    plan = planClaudeSession({
      dataDir: cfg.dataDir,
      name: opts.session,
      cwd: opts.cwd ?? cfg.repo,
      resume: opts.resume,
    });
    if (plan.resume) args.push("--resume", plan.id);
    else args.push("--session-id", plan.id);
  }
  if (opts.system) args.push("--system-prompt-file", writeSystemPrompt(cfg.dataDir, opts.session ?? "main", opts.system));
  return { args, plan };
}

export function buildClaudeArgs(cfg: NcliConfig, opts: RunOpts): string[] {
  return claudeSpawn(cfg, opts).args;
}

export function planClaudeSession(opts: {
  dataDir: string;
  name: string;
  cwd?: string;
  resume?: boolean;
  capBytes?: number;
  projectsDir?: string;
}): ClaudeSessionPlan {
  const dir = join(opts.dataDir, "sessions");
  mkdirSync(dir, { recursive: true });
  const path = sessionIdPath(opts.dataDir, opts.name);
  const cap = opts.capBytes ?? claudeSessionCap();
  const existing = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (existing && opts.resume !== false) {
    const bytes = claudeSessionBytes(existing, opts.cwd, opts.projectsDir);
    if (bytes <= cap) return { id: existing, resume: true, rotated: false };
    const id = randomUUID();
    writeFileSync(path, id, "utf8");
    return { id, resume: false, rotated: true };
  }
  const id = existing && opts.resume === false ? existing : randomUUID();
  writeFileSync(path, id, "utf8");
  return { id, resume: false, rotated: false };
}

export function resolveClaudeSession(dataDir: string, name: string, resume?: boolean): { id: string; resume: boolean } {
  const plan = planClaudeSession({ dataDir, name, resume });
  return { id: plan.id, resume: plan.resume };
}

export function claudeProjectSlug(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

export function claudeSessionJsonl(id: string, cwd?: string, projectsDir?: string): string {
  const root = projectsDir ?? process.env.NCLI_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects", claudeProjectSlug(cwd ?? process.cwd()));
  return join(root, `${id}.jsonl`);
}

export function claudeSessionBytes(id: string, cwd?: string, projectsDir?: string): number {
  const path = claudeSessionJsonl(id, cwd, projectsDir);
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function persistClaudeModel(dataDir: string, name: string, model: string): void {
  persistSeatModel(dataDir, name, "claude", model);
}

export function readClaudeModel(dataDir: string, name: string): string | undefined {
  return readSeatModel(dataDir, name, "claude");
}

export function formatClaudeTrace(trace: ClaudeTurnTrace): string {
  const origin = trace.hot ? trace.turnAt : trace.spawnAt;
  const init = trace.initAt != null ? `${Math.round(trace.initAt - origin)}ms` : "-";
  const token = trace.firstTokenAt != null ? `${Math.round(trace.firstTokenAt - origin)}ms` : "-";
  return `claude ${trace.hot ? "hot" : "cold"} session=${trace.sessionId}${trace.rotated ? " rotated" : ""} ${trace.hot ? "turn" : "spawn"}→init=${init} ${trace.hot ? "turn" : "spawn"}→token=${token}`;
}

export interface ClaudeFold {
  sawPartialText: boolean;
  sawPartialThink: boolean;
  emittedText: boolean;
  needTextBreak: boolean;
}

export function newClaudeFold(): ClaudeFold {
  return { sawPartialText: false, sawPartialThink: false, emittedText: false, needTextBreak: false };
}

export function foldClaudeLines(lines: string[]): AcpUpdate[] {
  const fold = newClaudeFold();
  return lines.flatMap((line) => foldClaudeLine(fold, line));
}

export function foldClaudeLine(state: ClaudeFold, line: string): AcpUpdate[] {
  const kind = lineKind(line);
  if (kind === "stream_event" && state.emittedText && isTextBlockStart(line)) {
    state.needTextBreak = true;
  }
  const out: AcpUpdate[] = [];
  for (const update of parseClaudeLine(line)) {
    if (kind === "stream_event") {
      if (update.sessionUpdate === "agent_message_chunk") state.sawPartialText = true;
      if (update.sessionUpdate === "agent_thought_chunk") state.sawPartialThink = true;
    }
    if (kind === "assistant") {
      if (update.sessionUpdate === "agent_message_chunk" && state.sawPartialText) continue;
      if (update.sessionUpdate === "agent_thought_chunk" && state.sawPartialThink) continue;
    }
    if (update.sessionUpdate === "tool_call" && state.emittedText) state.needTextBreak = true;
    if (update.sessionUpdate === "agent_message_chunk" && update.text) {
      if (state.needTextBreak) {
        out.push({ sessionUpdate: "agent_message_chunk", text: "\n\n" });
        state.needTextBreak = false;
      }
      state.emittedText = true;
    }
    out.push(update);
  }
  return out;
}

function isTextBlockStart(line: string): boolean {
  try {
    const ev = JSON.parse(line) as StreamLine;
    return ev.event?.type === "content_block_start" && ev.event.content_block?.type === "text";
  } catch {
    return false;
  }
}

export function parseClaudeLine(line: string): AcpUpdate[] {
  let ev: StreamLine;
  try {
    ev = JSON.parse(line) as StreamLine;
  } catch {
    return [];
  }
  switch (ev.type) {
    case "assistant": {
      const out: AcpUpdate[] = [];
      for (const block of ev.message?.content ?? []) {
        if ((block.type === "thinking" || block.type === "reasoning") && (block.thinking || block.text)) {
          out.push({ sessionUpdate: "agent_thought_chunk", text: block.thinking || block.text || "" });
        }
        if (block.type === "text" && block.text) {
          out.push({ sessionUpdate: "agent_message_chunk", text: block.text });
        }
        if (block.type === "tool_use" && block.name) {
          out.push({
            sessionUpdate: "tool_call",
            toolCallId: block.id ?? block.name,
            title: block.name,
            rawInput: block.input ?? {},
          });
        }
      }
      return out;
    }
    case "user": {
      const out: AcpUpdate[] = [];
      for (const block of ev.message?.content ?? []) {
        if (block.type === "tool_result") {
          out.push({
            sessionUpdate: "tool_call_update",
            toolCallId: block.tool_use_id ?? "",
            content: stringifyResult(block.content),
          });
        }
      }
      return out;
    }
    case "stream_event":
      return parseStreamEvent(ev.event);
    case "system":
      if (ev.subtype === "init" && ev.model) return [{ sessionUpdate: "model", model: ev.model }];
      return [];
    case "result":
    case "rate_limit_event":
      return [];
    default:
      return [];
  }
}

function parseStreamEvent(event: StreamLine["event"]): AcpUpdate[] {
  if (!event) return [];
  const delta = event.delta;
  if (event.type === "content_block_delta" && delta) {
    if ((delta.type === "text_delta" || delta.type === "text") && delta.text) {
      return [{ sessionUpdate: "agent_message_chunk", text: delta.text }];
    }
    if ((delta.type === "thinking_delta" || delta.type === "reasoning_delta") && (delta.thinking || delta.text)) {
      return [{ sessionUpdate: "agent_thought_chunk", text: delta.thinking || delta.text || "" }];
    }
  }
  const block = event.content_block;
  if (event.type === "content_block_start" && block) {
    if (block.type === "tool_use" && block.name) {
      return [{
        sessionUpdate: "tool_call",
        toolCallId: block.id ?? block.name,
        title: block.name,
        rawInput: block.input ?? {},
      }];
    }
    if (block.type === "thinking" && block.thinking) {
      return [{ sessionUpdate: "agent_thought_chunk", text: block.thinking }];
    }
    if (block.type === "text" && block.text) {
      return [{ sessionUpdate: "agent_message_chunk", text: block.text }];
    }
  }
  return [];
}

function lineKind(line: string): string {
  try {
    return String((JSON.parse(line) as StreamLine).type ?? "");
  } catch {
    return "";
  }
}

function isTokenLine(line: string): boolean {
  for (const update of parseClaudeLine(line)) {
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") return true;
  }
  return false;
}

function writeSystemPrompt(dataDir: string, session: string, system: string): string {
  const dir = join(dataDir, "prompts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${session}.txt`);
  writeFileSync(path, system, "utf8");
  return path;
}

function stringifyResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: string }).text) : JSON.stringify(c)))
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

function sessionIdPath(dataDir: string, name: string): string {
  return join(dataDir, "sessions", `${safeSession(name)}.id`);
}

function safeSession(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function claudeSessionCap(): number {
  const n = Number(process.env.NCLI_CLAUDE_SESSION_CAP ?? "");
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CLAUDE_SESSION_CAP;
}

function liveFingerprint(cfg: NcliConfig, opts: RunOpts, sessionId: string): string {
  return [
    cfg.claudeBin,
    opts.model ?? cfg.claudeModel,
    opts.mcpConfigPath ?? "",
    ...(opts.addDir ?? []),
    sessionId,
    opts.system ?? "",
    opts.cwd ?? cfg.repo,
  ].join("\0");
}

function sessionIdOf(args: string[]): string {
  const resume = args.indexOf("--resume");
  if (resume >= 0) return args[resume + 1] ?? "";
  const sid = args.indexOf("--session-id");
  return sid >= 0 ? args[sid + 1] ?? "" : "";
}

function writeClaudeUser(proc: ReturnType<typeof Bun.spawn>, text: string): void {
  const stdin = proc.stdin;
  if (!stdin || typeof stdin === "number") throw new Error("claude stdin is closed");
  stdin.write(claudeUserLine(text));
}

async function drainStderr(stream: ReadableStream<Uint8Array>, hot: HotProc): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      hot.stderr += decoder.decode(value, { stream: true });
    }
  } catch {
  } finally {
    reader.releaseLock();
  }
}

function debugClaude(msg: string): void {
  if (process.env.NCLI_DEBUG === "1" || process.env.NCLI_CLAUDE_DEBUG === "1") {
    console.error(msg);
  }
}

function logClaudeTrace(trace: ClaudeTurnTrace): void {
  debugClaude(formatClaudeTrace(trace));
}
