import { homedir } from "node:os";
import type { NcliConfig } from "../config";
import { childEnv } from "../harness/child-env";
import type { RunOpts } from "../harness/types";
import { cursorCliConfigPath, holdFile } from "../memory/cli-config";
import { NdjsonRpc } from "./rpc";
import type { AcpAdapter, AcpUpdate } from "./types";

export function cursorAcpSpawn(cfg: NcliConfig): { command: string; args: string[] } {
  const raw = cfg.acpCursor.trim().split(/\s+/);
  const command = raw[0] ?? "cursor-agent";
  const rest = raw.slice(1);
  const args: string[] = [];
  if (cfg.cursorModel && !rest.includes("--model")) {
    args.push("--model", cfg.cursorModel);
  }
  args.push(...rest);
  return { command, args };
}

export type CursorAcpServer =
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { type: "stdio"; name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

export function cursorAcpServers(
  servers: NonNullable<RunOpts["mcpServers"]>,
): CursorAcpServer[] {
  return servers.map((s) => {
    if (s.type === "http" || s.url) {
      return {
        type: "http",
        name: s.name,
        url: s.url ?? "",
        headers: nameValues(s.headers),
      };
    }
    return {
      type: "stdio",
      name: s.name,
      command: s.command ?? "bun",
      args: s.args ?? [],
      env: nameValues(s.env),
    };
  });
}

function nameValues(rec?: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(rec ?? {})
    .filter(([, value]) => value !== "")
    .map(([name, value]) => ({ name, value }));
}

export class CursorAcpAdapter implements AcpAdapter {
  readonly id = "cursor";
  constructor(private readonly cfg: NcliConfig) {}

  async *run(opts: RunOpts): AsyncIterable<AcpUpdate> {
    const spawn = cursorAcpSpawn(this.cfg);
    const env = childEnv(process.env, { allowAnthropicKey: false });
    const cliConfig = cursorCliConfigPath(homedir());
    yield { sessionUpdate: "model", model: this.cfg.cursorModel };
    const release = holdFile(cliConfig);
    try {
      yield* this.drive(opts, spawn, env);
    } finally {
      release();
    }
  }

  private async *drive(
    opts: RunOpts,
    spawn: { command: string; args: string[] },
    env: Record<string, string>,
  ): AsyncIterable<AcpUpdate> {
    const proc = Bun.spawn([spawn.command, ...spawn.args], {
      cwd: opts.cwd ?? this.cfg.repo,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const rpc = new NdjsonRpc(proc.stdin, proc.stdout);
    const q: AcpUpdate[] = [];
    let wake: (() => void) | null = null;
    rpc.onNotification = (method, params) => {
      if (method !== "session/update") return;
      const update = (params as { update?: Record<string, unknown> }).update;
      if (update) q.push(...cursorUpdate(update));
      wake?.();
    };
    rpc.onRequest = (id, method, params) => {
      if (method !== "session/request_permission") return;
      const tool = (params as { toolCall?: { toolCallId?: string; title?: string } }).toolCall;
      q.push({
        sessionUpdate: "permission_request",
        toolCallId: tool?.toolCallId ?? "perm",
        title: tool?.title ?? "permission",
      });
      rpc.respond(id, { outcome: { outcome: "selected", optionId: "allow-once" } });
      wake?.();
    };
    try {
      await rpc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: "ncli", version: "0.2.0" },
      });
      const { sessionId } = (await rpc.request("session/new", {
        cwd: opts.cwd ?? this.cfg.repo,
        mcpServers: cursorAcpServers(opts.mcpServers ?? []),
      })) as { sessionId: string };
      const promptText = opts.system ? `${opts.system}\n\n${opts.prompt}` : opts.prompt;
      const promptP = rpc.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: promptText }],
      });
      let done = false;
      promptP.finally(() => {
        done = true;
        wake?.();
      });
      while (!done || q.length) {
        if (q.length) {
          yield q.shift()!;
          continue;
        }
        await new Promise<void>((r) => {
          wake = r;
        });
      }
      await promptP;
    } finally {
      rpc.close();
      proc.kill();
    }
  }
}

export function cursorUpdate(update: Record<string, unknown>): AcpUpdate[] {
  const kind = String(update.sessionUpdate ?? "");
  switch (kind) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && content.text) {
        return [{ sessionUpdate: "agent_message_chunk", text: content.text }];
      }
      return [];
    }
    case "tool_call":
      return [
        {
          sessionUpdate: "tool_call",
          toolCallId: String(update.toolCallId ?? "tool"),
          title: String(update.title ?? "tool"),
          rawInput: (update.rawInput as Record<string, unknown>) ?? {},
        },
      ];
    case "tool_call_update":
      return [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: String(update.toolCallId ?? ""),
          content: JSON.stringify(update.content ?? update.status ?? "ok"),
        },
      ];
    case "plan": {
      const entries = (update.entries as Array<{ content?: string }> | undefined) ?? [];
      return [{ sessionUpdate: "plan", entries: entries.map((e) => e.content ?? "") }];
    }
    default:
      return [];
  }
}
