import type { NcliConfig } from "../config";
import { childEnv } from "../harness/child-env";
import type { RunOpts } from "../harness/types";
import type { AcpAdapter, AcpUpdate } from "./types";

export class CodexExecAdapter implements AcpAdapter {
  readonly id = "codex";
  constructor(private readonly cfg: NcliConfig) {}

  async *run(opts: RunOpts): AsyncIterable<AcpUpdate> {
    yield { sessionUpdate: "model", model: this.cfg.codexModel };
    const args = buildCodexArgs(this.cfg, opts);
    const proc = Bun.spawn(args, {
      cwd: opts.cwd ?? this.cfg.repo,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: childEnv(process.env, { allowAnthropicKey: false }),
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
          yield* parseCodexLine(line);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(err.trim() || `codex exited ${code}`);
    }
  }
}

export function buildCodexArgs(cfg: NcliConfig, opts: RunOpts): string[] {
  const prompt = opts.system ? `${opts.system}\n\n${opts.prompt}` : opts.prompt;
  const args = [cfg.codexBin, "exec", "--json"];
  if (cfg.codexModel) args.push("--model", cfg.codexModel);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  args.push(prompt);
  return args;
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
  const text = pickText(item) || pickText(ev);
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

function pickText(obj: Record<string, unknown>): string {
  for (const key of ["text", "output", "content", "message", "result"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
