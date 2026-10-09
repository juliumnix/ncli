import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NcliConfig } from "../config";
import { childEnv } from "../harness/child-env";
import type { RunOpts } from "../harness/types";
import type { AcpAdapter, AcpUpdate } from "./types";

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

export class ClaudeCliAdapter implements AcpAdapter {
  readonly id = "claude";
  constructor(private readonly cfg: NcliConfig) {}

  async *run(opts: RunOpts): AsyncIterable<AcpUpdate> {
    const args = buildClaudeArgs(this.cfg, opts);
    const proc = Bun.spawn(args, {
      cwd: opts.cwd ?? this.cfg.repo,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: childEnv(process.env, { allowAnthropicKey: this.cfg.claudeApiKey }),
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const fold = newClaudeFold();
    try {
      while (true) {
        if (opts.signal?.aborted) {
          proc.kill();
          break;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          yield* foldClaudeLine(fold, line);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(err.trim() || `claude exited ${code}`);
    }
  }
}

export function buildClaudeArgs(cfg: NcliConfig, opts: RunOpts): string[] {
  const args = [cfg.claudeBin, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (opts.model ?? cfg.claudeModel) args.push("--model", opts.model ?? cfg.claudeModel);
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
  for (const dir of opts.addDir ?? []) args.push("--add-dir", dir);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  if (opts.session) {
    const sess = resolveClaudeSession(cfg.dataDir, opts.session, opts.resume);
    if (sess.resume) args.push("--resume", sess.id);
    else args.push("--session-id", sess.id);
  }
  if (opts.system) args.push("--system-prompt-file", writeSystemPrompt(cfg.dataDir, opts.session ?? "main", opts.system));
  args.push(opts.prompt);
  return args;
}

export function resolveClaudeSession(dataDir: string, name: string, resume?: boolean): { id: string; resume: boolean } {
  const dir = join(dataDir, "sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name.replace(/[^a-zA-Z0-9._-]/g, "_")}.id`);
  if (existsSync(path)) {
    const id = readFileSync(path, "utf8").trim();
    if (id) return { id, resume: resume !== false };
  }
  const id = randomUUID();
  writeFileSync(path, id, "utf8");
  return { id, resume: false };
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
