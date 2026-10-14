import { homedir } from "node:os";
import { join } from "node:path";
import type { NcliConfig } from "../config";
import { childEnv } from "../harness/child-env";
import type { RunOpts } from "../harness/types";
import { cursorCliConfigPath, holdFile } from "../memory/cli-config";
import { NdjsonRpc } from "./rpc";
import {
  debugSeat,
  DEFAULT_SESSION_CAP,
  fileBytes,
  formatSeatTrace,
  persistSeatId,
  persistSeatModel,
  sessionCap,
  type SeatTurnTrace,
} from "./session";
import { NCLI_TOOLS } from "../mcp/tools";
import type { AcpAdapter, AcpUpdate } from "./types";
import { SessionHot, sessionKey } from "./hot";

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

export type CursorPermissionOption = {
  optionId: string;
  name?: string;
  kind?: string;
};

export type CursorPermissionRequest = {
  toolCall?: { toolCallId?: string; title?: string };
  options?: CursorPermissionOption[];
};

const NCLI_TOOL_NAMES = new Set(NCLI_TOOLS.map((t) => t.name));

export function isNcliMcpTitle(title: string): boolean {
  const t = title.trim();
  if (/^mcp__ncli__/i.test(t)) return true;
  const bare = t.replace(/^mcp__/, "").replace(/^ncli__/i, "");
  return NCLI_TOOL_NAMES.has(t) || NCLI_TOOL_NAMES.has(bare);
}

export function cursorPermissionChoice(params: CursorPermissionRequest): string {
  const options = params.options ?? [];
  const pick = (kind: string, re: RegExp) =>
    options.find((o) => o.kind === kind || re.test(o.optionId))?.optionId;
  if (isNcliMcpTitle(params.toolCall?.title ?? "")) {
    return pick("allow_always", /allow[_-]?always/i) ?? "allow-always";
  }
  return pick("allow_once", /allow[_-]?once/i) ?? "allow-once";
}

function nameValues(rec?: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(rec ?? {})
    .filter(([, value]) => value !== "")
    .map(([name, value]) => ({ name, value }));
}

interface HotAcp {
  proc: ReturnType<typeof Bun.spawn>;
  rpc: NdjsonRpc;
  fingerprint: string;
  sessionId: string;
  spawnAt: number;
  initAt: number;
  bytes: number;
  rotated: boolean;
  extraDirs: boolean;
  release: () => void;
  q: AcpUpdate[];
  wake: (() => void) | null;
}

export class CursorAcpAdapter implements AcpAdapter {
  readonly id = "cursor";
  lastTrace: SeatTurnTrace | null = null;
  private readonly table = new SessionHot<HotAcp>();

  constructor(private readonly cfg: NcliConfig) {}

  async warm(opts: RunOpts): Promise<void> {
    await this.ensureHot(opts);
  }

  close(): void {
    for (const hot of this.table.takeAll()) this.kill(hot);
  }

  release(session: string): void {
    this.kill(this.table.take(sessionKey(session)));
  }

  async *run(opts: RunOpts): AsyncIterable<AcpUpdate> {
    if (this.cfg.cursorModel) {
      persistSeatModel(this.cfg.dataDir, opts.session ?? "main", "cursor", this.cfg.cursorModel);
      yield { sessionUpdate: "model", model: this.cfg.cursorModel };
    }
    const { hot, reused } = await this.ensureHot(opts);
    let rotated = reused ? false : hot.rotated;
    if (reused && this.shouldRotate(hot, opts)) {
      await this.openSession(hot, opts);
      hot.bytes = 0;
      hot.rotated = true;
      rotated = true;
    }
    const trace: SeatTurnTrace = {
      seat: "cursor",
      spawnAt: hot.spawnAt,
      turnAt: performance.now(),
      initAt: reused ? performance.now() : hot.initAt,
      sessionId: hot.sessionId,
      rotated,
      hot: reused,
    };
    const promptText = opts.system ? `${opts.system}\n\n${opts.prompt}` : opts.prompt;
    const promptP = hot.rpc.request("session/prompt", {
      sessionId: hot.sessionId,
      prompt: [{ type: "text", text: promptText }],
    });
    let done = false;
    promptP.finally(() => {
      done = true;
      hot.wake?.();
    });
    try {
      while (!done || hot.q.length) {
        if (opts.signal?.aborted) {
          this.release(sessionKey(opts.session));
          break;
        }
        if (hot.q.length) {
          const update = hot.q.shift()!;
          if (!trace.firstTokenAt && isTokenUpdate(update)) trace.firstTokenAt = performance.now();
          if (update.sessionUpdate === "model") {
            persistSeatModel(this.cfg.dataDir, opts.session ?? "main", "cursor", update.model);
          }
          yield update;
          continue;
        }
        await new Promise<void>((r) => {
          hot.wake = r;
        });
      }
      await promptP;
      hot.bytes += promptText.length;
    } finally {
      trace.resultAt = performance.now();
      this.lastTrace = trace;
      debugSeat(formatSeatTrace(trace));
    }
  }

  private async ensureHot(opts: RunOpts): Promise<{ hot: HotAcp; reused: boolean }> {
    const spawn = cursorAcpSpawn(this.cfg);
    const fp = liveFingerprint(this.cfg, opts, spawn);
    const key = sessionKey(opts.session);
    return this.table.acquire(key, fp, () => this.spawnHot(key, spawn, fp, opts));
  }

  private async spawnHot(
    key: string,
    spawn: { command: string; args: string[] },
    fingerprint: string,
    opts: RunOpts,
  ): Promise<HotAcp> {
    this.kill(this.table.take(key));
    const spawnAt = performance.now();
    const env = childEnv(process.env, { allowAnthropicKey: false });
    const release = holdFile(cursorCliConfigPath(homedir()));
    const proc = Bun.spawn([spawn.command, ...spawn.args], {
      cwd: opts.cwd ?? this.cfg.repo,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const stdin = proc.stdin;
    if (!stdin || typeof stdin === "number") {
      release();
      throw new Error("cursor stdin is closed");
    }
    const rpc = new NdjsonRpc(stdin, proc.stdout);
    const hot: HotAcp = {
      proc,
      rpc,
      fingerprint,
      sessionId: "",
      spawnAt,
      initAt: spawnAt,
      bytes: 0,
      rotated: false,
      extraDirs: false,
      release,
      q: [],
      wake: null,
    };
    rpc.onNotification = (method, params) => {
      if (method !== "session/update") return;
      const update = (params as { update?: Record<string, unknown> }).update;
      if (update) hot.q.push(...cursorUpdate(update));
      hot.wake?.();
    };
    rpc.onRequest = (id, method, params) => {
      if (method !== "session/request_permission") return;
      const req = (params ?? {}) as CursorPermissionRequest;
      const tool = req.toolCall;
      hot.q.push({
        sessionUpdate: "permission_request",
        toolCallId: tool?.toolCallId ?? "perm",
        title: tool?.title ?? "permission",
      });
      rpc.respond(id, { outcome: { outcome: "selected", optionId: cursorPermissionChoice(req) } });
      hot.wake?.();
    };
    const init = await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "ncli", version: "0.2.0" },
    });
    hot.extraDirs = cursorAllowsExtraDirs(init);
    hot.initAt = performance.now();
    await this.openSession(hot, opts);
    debugSeat(`cursor spawn session=${hot.sessionId}`);
    return hot;
  }

  private async openSession(hot: HotAcp, opts: RunOpts): Promise<void> {
    const additionalDirectories = (opts.addDir ?? []).filter((dir) => dir.startsWith("/"));
    const { sessionId } = (await hot.rpc.request("session/new", {
      cwd: opts.cwd ?? this.cfg.repo,
      mcpServers: cursorAcpServers(opts.mcpServers ?? []),
      ...(hot.extraDirs && additionalDirectories.length ? { additionalDirectories } : {}),
    })) as { sessionId: string };
    hot.sessionId = sessionId;
    persistSeatId(this.cfg.dataDir, opts.session ?? "main", "cursor", sessionId);
  }

  private shouldRotate(hot: HotAcp, opts: RunOpts): boolean {
    const cap = sessionCap("NCLI_CURSOR_SESSION_CAP", DEFAULT_SESSION_CAP);
    if (hot.bytes > cap) return true;
    return cursorSessionBytes(hot.sessionId, opts.cwd ?? this.cfg.repo) > cap;
  }

  private kill(hot: HotAcp | undefined): void {
    if (!hot) return;
    try {
      hot.rpc.close();
    } catch {}
    try {
      hot.proc.kill();
    } catch {}
    try {
      hot.release();
    } catch {}
  }
}

export function cursorAllowsExtraDirs(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const caps = (result as { agentCapabilities?: Record<string, unknown> }).agentCapabilities;
  if (!caps) return false;
  const session = caps.sessionCapabilities ?? caps.session;
  if (!session || typeof session !== "object") return false;
  return (session as { additionalDirectories?: unknown }).additionalDirectories != null;
}

export function cursorProjectSlug(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

export function defaultCursorProjectsDir(): string {
  return process.env.NCLI_CURSOR_PROJECTS?.trim() || join(homedir(), ".cursor", "projects");
}

export function cursorSessionBytes(id: string, cwd?: string, projectsDir?: string): number {
  if (!id) return 0;
  const root = projectsDir ?? defaultCursorProjectsDir();
  const slug = cursorProjectSlug(cwd ?? process.cwd());
  const nested = join(root, slug, "agent-transcripts", id, `${id}.jsonl`);
  const flat = join(root, slug, "agent-transcripts", `${id}.jsonl`);
  return Math.max(fileBytes(nested), fileBytes(flat));
}

export function cursorUpdate(update: Record<string, unknown>): AcpUpdate[] {
  const kind = String(update.sessionUpdate ?? "");
  const model = pickCursorModel(update);
  if (model) return [{ sessionUpdate: "model", model }];
  switch (kind) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && content.text) {
        return [{ sessionUpdate: kind === "agent_thought_chunk" ? "agent_thought_chunk" : "agent_message_chunk", text: content.text }];
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

function pickCursorModel(update: Record<string, unknown>): string {
  const kind = String(update.sessionUpdate ?? "");
  if (kind !== "model" && kind !== "current_mode_update") return "";
  for (const key of ["model", "currentMode"]) {
    const v = update[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function liveFingerprint(
  cfg: NcliConfig,
  opts: RunOpts,
  spawn: { command: string; args: string[] },
): string {
  return [
    spawn.command,
    spawn.args.join(" "),
    cfg.cursorModel,
    opts.cwd ?? cfg.repo,
    JSON.stringify(opts.mcpServers ?? []),
    ...(opts.addDir ?? []),
  ].join("\0");
}

function isTokenUpdate(update: AcpUpdate): boolean {
  return update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk";
}
