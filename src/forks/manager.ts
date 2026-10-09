import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Fork, ForkStatus, Message, NeedsUser } from "../types";
import type { NcliConfig } from "../config";
import type { Harness, HarnessEvent } from "../harness/types";
import type { ViewAction } from "../views/types";
import type { ViewRegistry } from "../views/registry";
import type { GhClient } from "../gh/pr";
import { Memory, type Compressor } from "../memory/store";
import { assemble } from "../memory/assemble";
import { toolActivityLine } from "../memory/turn-log";
import { addWorktree, removeWorktree, type GitRunner, type WorktreeHandle } from "./worktree";
import { nowIso } from "../util";
import type { Bus } from "../bus/bus";
import { LiveTurn } from "../live/turn";
import { seatOf } from "../agent";
import type { SpawnInject } from "../mcp/inject";

export interface ForkRuntime {
  fork: Fork;
  memory: Memory;
  abort: AbortController;
  worktree?: WorktreeHandle;
  seats: Record<string, string>;
}

export interface ForkManagerHooks {
  onEvent: (ev: { type: string; session: string; payload?: unknown }) => void;
  onMerge: (fork: Fork, summary: string) => void;
  compressor: Compressor;
  harness: Harness;
  git?: GitRunner;
  bus?: Bus;
  inject?: (session: string, worktree?: string) => SpawnInject;
}

export class ForkManager {
  readonly runtimes = new Map<string, ForkRuntime>();
  private seqByView = new Map<string, number>();

  constructor(
    private readonly cfg: NcliConfig,
    private readonly views: ViewRegistry,
    private readonly gh: GhClient,
    private readonly hooks: ForkManagerHooks,
  ) {
    mkdirSync(join(cfg.dataDir, "forks"), { recursive: true });
  }

  restore(): void {
    const root = join(this.cfg.dataDir, "forks");
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      const meta = loadForkMeta(this.cfg.dataDir, name);
      if (!meta) continue;
      const prev = this.seqByView.get(meta.view) ?? 0;
      if (meta.seq > prev) this.seqByView.set(meta.view, meta.seq);
      const memory = new Memory({
        dir: join(root, name),
        nodeBytes: this.cfg.nodeBytes,
        viewBytes: this.cfg.viewBytes,
        compressor: this.hooks.compressor,
        pumpBatch: this.cfg.compactBatch,
      });
      const worktree = meta.worktree && meta.branch && meta.repo
        ? { path: join(meta.repo, ".ncli", "wt", name), branch: meta.branch, repo: meta.repo }
        : undefined;
      this.runtimes.set(meta.id, {
        fork: meta,
        memory,
        abort: new AbortController(),
        worktree,
        seats: {},
      });
    }
  }

  seedViewSeq(view: string, last: number): void {
    this.seqByView.set(view, last);
  }

  list(): Fork[] {
    return [...this.runtimes.values()].map((r) => r.fork);
  }

  setHarness(harness: Harness): void {
    this.hooks.harness = harness;
  }

  waitingOnUser(): Fork[] {
    return this.list().filter((f) => f.status === "needs_user");
  }

  get(id: string): ForkRuntime | undefined {
    return this.runtimes.get(id);
  }

  async open(viewId: string, params: Record<string, string>): Promise<ForkRuntime> {
    const plugin = this.views.get(viewId);
    if (!plugin) throw new Error(`view desconhecida: ${viewId}`);
    const seq = (this.seqByView.get(viewId) ?? 0) + 1;
    this.seqByView.set(viewId, seq);
    const id = `${viewId}-${seq}`;
    const parsed = plugin.parseLink?.(params) ?? params;
    const created = await plugin.createFork(parsed, {
      dataDir: this.cfg.dataDir,
      repo: this.cfg.repo,
      fetchPr: (pr) => this.gh.view(pr),
    });
    const fork: Fork = {
      id,
      seq,
      view: viewId,
      title: created.title,
      status: created.needsUser ? "needs_user" : "running",
      needsUser: created.needsUser,
      params: parsed,
      createdAt: nowIso(),
      ui: created.ui,
      repo: created.repo,
      hold: created.hold,
    };
    let worktree: WorktreeHandle | undefined;
    if (created.needsWorktree) {
      try {
        worktree = await addWorktree(created.repo ?? this.cfg.repo, id, this.hooks.git);
        fork.worktree = shortWt(worktree.path);
        fork.branch = worktree.branch;
      } catch {
        fork.worktree = "sem wt";
      }
    }
    const memory = new Memory({
      dir: join(this.cfg.dataDir, "forks", id),
      nodeBytes: this.cfg.nodeBytes,
      viewBytes: this.cfg.viewBytes,
      compressor: this.hooks.compressor,
      pumpBatch: this.cfg.compactBatch,
    });
    const rt: ForkRuntime = {
      fork,
      memory,
      abort: new AbortController(),
      worktree,
      seats: {},
    };
    this.runtimes.set(id, rt);
    persistFork(this.cfg.dataDir, fork);
    this.hooks.onEvent({ type: "fork", session: id, payload: fork });
    void this.runTurn(rt, created.prompt, true);
    return rt;
  }

  async message(id: string, text: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(`fork ${id} não existe`);
    const plugin = this.views.get(rt.fork.view);
    if (plugin?.applyAction) {
      await this.act(id, { type: "say", value: text });
      return;
    }
    rt.fork.status = "running";
    rt.fork.needsUser = undefined;
    persistFork(this.cfg.dataDir, rt.fork);
    this.hooks.onEvent({ type: "fork", session: id, payload: rt.fork });
    await this.runTurn(rt, text, false);
  }

  async act(id: string, action: ViewAction): Promise<Fork> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(`fork ${id} não existe`);
    const plugin = this.views.get(rt.fork.view);
    const posted = [action.type, action.id, action.value].filter(Boolean).join(" ");
    rt.memory.append({ kind: "user", text: posted });
    const result = plugin?.applyAction?.(rt.fork, action);
    if (result?.ui !== undefined) rt.fork.ui = result.ui;
    if (result?.needsUser === null) {
      rt.fork.needsUser = undefined;
      if (!result.merge) rt.fork.status = "running";
    } else if (result?.needsUser) {
      rt.fork.needsUser = result.needsUser;
      rt.fork.status = "needs_user";
    }
    persistFork(this.cfg.dataDir, rt.fork);
    this.hooks.onEvent({ type: "fork", session: id, payload: rt.fork });
    if (result?.merge) {
      await this.merge(rt, result.summary ?? rt.fork.summary ?? posted);
    }
    return rt.fork;
  }

  async finish(id: string, summary?: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    await this.merge(rt, summary ?? rt.fork.summary ?? `fork ${id} terminou`);
  }

  async close(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.abort.abort();
    if (rt.fork.status !== "merged") {
      await this.merge(rt, rt.fork.summary ?? "fechado");
    }
    if (rt.worktree) {
      try {
        await removeWorktree(rt.worktree, this.hooks.git);
      } catch {
        rt.worktree = undefined;
      }
    }
  }

  private async runTurn(rt: ForkRuntime, userText: string, isBoot: boolean): Promise<void> {
    void rt.memory.pump();
    const ctx = assemble(rt.memory, `You are running view '${rt.fork.view}' as fork ${rt.fork.id}. Isolated worktree: ${rt.worktree?.path ?? "none"}.`);
    if (!isBoot) rt.memory.append({ kind: "user", text: userText });
    else rt.memory.append({ kind: "note", text: `boot ${rt.fork.view} ${JSON.stringify(rt.fork.params)}` });
    let talk = "";
    try {
      const inbox = this.hooks.bus?.drainPrompt(rt.fork.id) ?? "";
      const inj = this.hooks.inject
        ? this.hooks.inject(rt.fork.id, rt.worktree?.path)
        : undefined;
      const live = new LiveTurn(rt.fork.id, seatOf(this.hooks.harness.id));
      const tools: string[] = [];
      this.hooks.onEvent({ type: "turn", session: rt.fork.id, payload: live.turn });
      for await (const ev of this.hooks.harness.run({
        prompt: `${inbox}${ctx.view}\n\n${userText}`,
        system: ctx.system,
        cwd: rt.worktree?.path ?? this.cfg.repo,
        session: rt.fork.id,
        signal: rt.abort.signal,
        mcpConfigPath: inj?.mcpConfigPath,
        mcpServers: inj?.mcpServers,
        addDir: this.hooks.harness.id === "claude" ? inj?.addDir : undefined,
        extraArgs: this.hooks.harness.id === "codex" ? inj?.extraArgs : undefined,
      })) {
        this.handleHarness(rt, ev, live, tools);
        if (ev.type === "text") talk += ev.text;
        if (ev.type === "done") talk = ev.text || talk;
        if (ev.type === "error") throw new Error(ev.error);
      }
      live.finish(rt.abort.signal.aborted ? "stopped" : "done");
      this.hooks.onEvent({ type: "turn", session: rt.fork.id, payload: live.turn });
      const summary = toolActivityLine(tools);
      if (summary) rt.memory.append({ kind: "note", text: summary, seat: seatOf(this.hooks.harness.id) });
      rt.fork.summary = talk.trim().slice(0, 400) || rt.fork.summary;
      if (rt.fork.status === "merged") return;
      if (rt.fork.needsUser) {
        rt.fork.status = "needs_user";
        persistFork(this.cfg.dataDir, rt.fork);
        this.hooks.onEvent({ type: "fork", session: rt.fork.id, payload: rt.fork });
        return;
      }
      if (rt.fork.hold) {
        rt.fork.status = "running";
        persistFork(this.cfg.dataDir, rt.fork);
        this.hooks.onEvent({ type: "fork", session: rt.fork.id, payload: rt.fork });
        return;
      }
      rt.fork.status = "done";
      await this.merge(rt, rt.fork.summary ?? talk);
    } catch (err) {
      rt.fork.status = "error";
      rt.fork.summary = (err as Error).message;
      persistFork(this.cfg.dataDir, rt.fork);
      this.hooks.onEvent({ type: "fork", session: rt.fork.id, payload: rt.fork });
    }
  }

  private handleHarness(rt: ForkRuntime, ev: HarnessEvent, live: LiveTurn, tools: string[]): void {
    const applied = live.apply(ev);
    this.hooks.onEvent({ type: "turn", session: rt.fork.id, payload: live.turn });
    if (applied.step) {
      this.hooks.onEvent({ type: "step", session: rt.fork.id, payload: { turnId: live.id, step: applied.step } });
    }
    switch (ev.type) {
      case "text":
      case "thinking":
      case "model":
        this.hooks.onEvent({ type: "delta", session: rt.fork.id, payload: ev });
        break;
      case "tool":
        tools.push(ev.name);
        this.hooks.onEvent({ type: "tool", session: rt.fork.id, payload: ev });
        break;
      case "tool_result":
        break;
      case "seat":
        if (ev.status === "done" && ev.text) {
          const msg = rt.memory.append({ kind: "seat", text: ev.text, seat: ev.seat });
          this.hooks.onEvent({ type: "message", session: rt.fork.id, payload: msg });
        } else {
          this.hooks.onEvent({ type: "delta", session: rt.fork.id, payload: ev });
        }
        break;
      case "done":
        if (ev.text) {
          const msg = rt.memory.append({ kind: "talk", text: ev.text, seat: seatOf(this.hooks.harness.id), model: live.turn.model });
          this.hooks.onEvent({ type: "message", session: rt.fork.id, payload: msg });
          const plugin = this.views.get(rt.fork.view);
          const patch = plugin?.onEvent?.(rt.fork, { type: "done", text: ev.text });
          if (patch?.ui !== undefined) {
            rt.fork.ui = patch.ui;
            persistFork(this.cfg.dataDir, rt.fork);
            this.hooks.onEvent({ type: "fork", session: rt.fork.id, payload: rt.fork });
          }
        }
        break;
      case "error":
        this.hooks.onEvent({ type: "error", session: rt.fork.id, payload: ev });
        break;
      default: {
        const _n: never = ev;
        void _n;
      }
    }
  }

  private async merge(rt: ForkRuntime, summary: string): Promise<void> {
    if (rt.fork.status === "merged") return;
    rt.fork.status = "merged";
    rt.fork.mergedAt = nowIso();
    rt.fork.summary = summary;
    persistFork(this.cfg.dataDir, rt.fork);
    this.hooks.onEvent({ type: "fork", session: rt.fork.id, payload: rt.fork });
    this.hooks.onMerge(rt.fork, summary);
  }
}

function shortWt(path: string): string {
  const parts = path.split("/");
  return `wt/${parts[parts.length - 1]}`;
}

function persistFork(dataDir: string, fork: Fork): void {
  const dir = join(dataDir, "forks", fork.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(fork, null, 2), "utf8");
}

export function loadForkMeta(dataDir: string, id: string): Fork | null {
  const p = join(dataDir, "forks", id, "meta.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Fork;
}

export function mergeMessage(fork: Fork, summary: string): Omit<Message, "i" | "size"> {
  return {
    kind: "merge",
    text: `${fork.view} #${fork.seq} voltou · ${oneLine(summary)}`,
    date: nowIso(),
    forkId: fork.id,
    seat: "claude",
  };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 220);
}

export type { ForkStatus, NeedsUser };
