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
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      content?: unknown;
      tool_use_id?: string;
    }>;
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
          yield* parseClaudeLine(line);
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
  const args = [cfg.claudeBin, "-p", "--output-format", "stream-json", "--verbose"];
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
    case "result":
      return [];
    case "system":
    case "stream_event":
    case "rate_limit_event":
      return [];
    default:
      return [];
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
