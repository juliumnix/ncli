import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Spark, SparkStatus, Message, NeedsUser } from "../types";
import type { NcliConfig } from "../config";
import type { Harness, HarnessEvent } from "../harness/types";
import type { ViewAction } from "../views/types";
import type { ViewRegistry } from "../views/registry";
import { assertRunnable, availableHarnesses, emptyResult, formatSparkResult, sparkSkillPrompt, type SparkResult } from "../views/manifest";
import type { GhClient } from "../gh/pr";
import { Memory, type Compressor } from "../memory/store";
import { assemble } from "../memory/assemble";
import { toolActivityLine } from "../memory/turn-log";
import { addWorktree, archiveWorktree, realGit, type ArchiveResult, type GitRunner, type WorktreeHandle } from "./worktree";
import { nowIso } from "../util";
import type { Bus } from "../bus/bus";
import { LiveTurn } from "../live/turn";
import { joinText } from "../live/join-text";
import { seatOf } from "../agent";
import type { SpawnInject } from "../mcp/inject";

export interface SparkRuntime {
  spark: Spark;
  memory: Memory;
  abort: AbortController;
  worktree?: WorktreeHandle;
  seats: Record<string, string>;
}

export interface SparkManagerHooks {
  onEvent: (ev: { type: string; session: string; payload?: unknown }) => void;
  onMerge: (spark: Spark, summary: string, result: SparkResult) => void;
  onIdle?: (sparkId: string) => void;
  compressor: Compressor;
  harness: Harness;
  git?: GitRunner;
  bus?: Bus;
  inject?: (session: string, worktree?: string) => SpawnInject;
}

export class SparkManager {
  readonly runtimes = new Map<string, SparkRuntime>();
  private seqByView = new Map<string, number>();

  constructor(
    private readonly cfg: NcliConfig,
    private readonly views: ViewRegistry,
    private readonly gh: GhClient,
    private readonly hooks: SparkManagerHooks,
  ) {
    mkdirSync(join(cfg.dataDir, "sparks"), { recursive: true });
  }

  restore(): void {
    const roots = ["sparks", "forks"].map((n) => join(this.cfg.dataDir, n)).filter((p) => existsSync(p));
    for (const root of roots) {
    for (const name of readdirSync(root)) {
      if (this.runtimes.has(name)) continue;
      const meta = loadSparkMeta(this.cfg.dataDir, name);
      if (!meta) continue;
      const prev = this.seqByView.get(meta.view) ?? 0;
      if (meta.seq > prev) this.seqByView.set(meta.view, meta.seq);
      const memory = new Memory({
        dir: join(root, name),
        nodeBytes: this.cfg.nodeBytes,
        viewBytes: this.cfg.viewBytes,
        compressor: this.hooks.compressor,
        pumpBatch: this.cfg.compactBatch,
        deferCutAfter: this.cfg.compactTries,
      });
      const worktree = meta.worktree && meta.branch && meta.repo
        ? { path: join(meta.repo, ".ncli", "wt", name), branch: meta.branch, repo: meta.repo }
        : undefined;
      this.runtimes.set(meta.id, {
        spark: meta,
        memory,
        abort: new AbortController(),
        worktree,
        seats: {},
      });
    }
    }
  }

  seedViewSeq(view: string, last: number): void {
    this.seqByView.set(view, last);
  }

  list(): Spark[] {
    return [...this.runtimes.values()].map((r) => r.spark);
  }

  setHarness(harness: Harness): void {
    this.hooks.harness = harness;
  }

  waitingOnUser(): Spark[] {
    return this.list().filter((f) => f.status === "needs_user");
  }

  get(id: string): SparkRuntime | undefined {
    return this.runtimes.get(id);
  }

  async open(viewId: string, params: Record<string, string>): Promise<SparkRuntime> {
    const plugin = this.views.get(viewId);
    if (!plugin) throw new Error(`view desconhecida: ${viewId}`);
    const pack = this.views.packageOf(viewId);
    if (pack) assertRunnable(pack.manifest, availableHarnesses({ harness: this.cfg.harness }));
    const seq = (this.seqByView.get(viewId) ?? 0) + 1;
    this.seqByView.set(viewId, seq);
    const id = `${viewId}-${seq}`;
    const parsed = plugin.parseLink?.(params) ?? params;
    const created = await plugin.createSpark(parsed, {
      dataDir: this.cfg.dataDir,
      repo: this.cfg.repo,
      fetchPr: (pr) => this.gh.view(pr),
    });
    const spark: Spark = {
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
      flowStep: created.flowStep ?? this.views.packageOf(viewId)?.manifest.flow[0]?.id,
    };
    let worktree: WorktreeHandle | undefined;
    if (created.needsWorktree) {
      try {
        worktree = await addWorktree(created.repo ?? this.cfg.repo, id, this.hooks.git);
        spark.worktree = shortWt(worktree.path);
        spark.branch = worktree.branch;
      } catch {
        spark.worktree = "sem wt";
      }
    }
    const memory = new Memory({
      dir: join(this.cfg.dataDir, "sparks", id),
      nodeBytes: this.cfg.nodeBytes,
      viewBytes: this.cfg.viewBytes,
      compressor: this.hooks.compressor,
      pumpBatch: this.cfg.compactBatch,
      deferCutAfter: this.cfg.compactTries,
    });
    const rt: SparkRuntime = {
      spark,
      memory,
      abort: new AbortController(),
      worktree,
      seats: {},
    };
    this.runtimes.set(id, rt);
    persistSpark(this.cfg.dataDir, spark);
    this.hooks.onEvent({ type: "spark", session: id, payload: spark });
    await this.maybeArchiveMerged(rt);
    void this.runTurn(rt, created.prompt, true);
    return rt;
  }

  async message(id: string, text: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(`spark ${id} não existe`);
    const plugin = this.views.get(rt.spark.view);
    if (plugin?.applyAction) {
      await this.act(id, { type: "say", value: text });
      return;
    }
    rt.spark.status = "running";
    rt.spark.needsUser = undefined;
    persistSpark(this.cfg.dataDir, rt.spark);
    this.hooks.onEvent({ type: "spark", session: id, payload: rt.spark });
    await this.runTurn(rt, text, false);
  }

  async act(id: string, action: ViewAction): Promise<Spark> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(`spark ${id} não existe`);
    const plugin = this.views.get(rt.spark.view);
    const posted = [action.type, action.id, action.value].filter(Boolean).join(" ");
    rt.memory.append({ kind: "user", text: posted });
    const result = await plugin?.applyAction?.(rt.spark, action, {
      dataDir: this.cfg.dataDir,
      repo: this.cfg.repo,
      fetchPr: (pr) => this.gh.view(pr),
    });
    if (result?.ui !== undefined) rt.spark.ui = result.ui;
    if (result?.flowStep) rt.spark.flowStep = result.flowStep;
    if (result?.result) rt.spark.result = result.result;
    if (result?.needsUser === null) {
      rt.spark.needsUser = undefined;
      if (!result.merge) rt.spark.status = "running";
    } else if (result?.needsUser) {
      rt.spark.needsUser = result.needsUser;
      rt.spark.status = "needs_user";
    }
    if (result?.note) {
      const note = rt.memory.append({ kind: "note", text: result.note });
      this.hooks.onEvent({ type: "message", session: id, payload: note });
    }
    persistSpark(this.cfg.dataDir, rt.spark);
    this.hooks.onEvent({ type: "spark", session: id, payload: rt.spark });
    await this.maybeArchiveMerged(rt);
    if (result?.ask) {
      rt.spark.status = "running";
      rt.spark.needsUser = undefined;
      persistSpark(this.cfg.dataDir, rt.spark);
      this.hooks.onEvent({ type: "spark", session: id, payload: rt.spark });
      await this.runTurn(rt, result.ask, false);
    }
    if (result?.merge) {
      await this.merge(rt, result.summary ?? rt.spark.summary ?? posted);
    }
    return rt.spark;
  }

  async finish(id: string, summary?: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    await this.merge(rt, summary ?? rt.spark.summary ?? `spark ${id} terminou`);
  }

  async close(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.abort.abort();
    if (rt.spark.status !== "merged") {
      await this.merge(rt, rt.spark.summary ?? "fechado");
    }
    await this.maybeArchiveMerged(rt);
    if (rt.worktree) {
      await this.archive(id, false);
    }
  }

  async maybeArchiveMerged(rt: SparkRuntime): Promise<void> {
    const pr = rt.spark.params.pr;
    if (!pr) return;
    try {
      const info = await this.gh.view(pr);
      if (rt.spark.ui && typeof rt.spark.ui === "object") {
        (rt.spark.ui as { prState?: string; head?: string }).prState = info.state;
        if (info.headOid) (rt.spark.ui as { head?: string }).head = info.headOid;
      }
      if (info.state !== "MERGED" || !rt.worktree) return;
      await this.archive(rt.spark.id, false);
    } catch {
      return;
    }
  }

  async archive(id: string, force = false): Promise<ArchiveResult | undefined> {
    const rt = this.runtimes.get(id);
    if (!rt?.worktree) return undefined;
    const result = await archiveWorktree(rt.worktree, this.hooks.git ?? realGit, { force });
    if (result.ok) {
      rt.worktree = undefined;
      rt.spark.worktree = "arquivo";
      persistSpark(this.cfg.dataDir, rt.spark);
      this.hooks.onEvent({ type: "spark", session: id, payload: rt.spark });
      return result;
    }
    const why = result.blocked === "dirty" ? result.status.files.join(", ") || "arquivos sujos" : "commits locais";
    rt.memory.append({
      kind: "note",
      text: `worktree ${result.blocked}: ${why}. Fecha de novo com force para arquivar.`,
    });
    persistSpark(this.cfg.dataDir, rt.spark);
    this.hooks.onEvent({ type: "spark", session: id, payload: rt.spark });
    return result;
  }

  private async runTurn(rt: SparkRuntime, userText: string, isBoot: boolean): Promise<void> {
    void rt.memory.pump();
    const pack = this.views.packageOf(rt.spark.view);
    const extra = pack
      ? `Spark ${rt.spark.id} of ${pack.manifest.name}. Isolated worktree: ${rt.worktree?.path ?? "none"}. Flow step: ${rt.spark.flowStep ?? "spark"}.`
      : `You are running view '${rt.spark.view}' as spark ${rt.spark.id}. Isolated worktree: ${rt.worktree?.path ?? "none"}.`;
    const ctx = assemble(
      rt.memory,
      extra,
      pack ? sparkSkillPrompt(pack) : undefined,
      pack ? "" : undefined,
    );
    if (!isBoot) rt.memory.append({ kind: "user", text: userText });
    else rt.memory.append({ kind: "note", text: `boot ${rt.spark.view} ${JSON.stringify(rt.spark.params)}` });
    let talk = "";
    try {
      const inbox = this.hooks.bus?.drainPrompt(rt.spark.id) ?? "";
      const inj = this.hooks.inject
        ? this.hooks.inject(rt.spark.id, rt.worktree?.path)
        : undefined;
      const live = new LiveTurn(rt.spark.id, seatOf(this.hooks.harness.id));
      const tools: string[] = [];
      this.hooks.onEvent({ type: "turn", session: rt.spark.id, payload: live.turn });
      for await (const ev of this.hooks.harness.run({
        prompt: `${ctx.view}\n\n${inbox}${userText}`,
        system: ctx.system,
        cwd: rt.worktree?.path ?? this.cfg.repo,
        session: rt.spark.id,
        signal: rt.abort.signal,
        mcpConfigPath: inj?.mcpConfigPath,
        mcpServers: inj?.mcpServers,
        addDir: this.hooks.harness.id === "claude" ? inj?.addDir : undefined,
        extraArgs: this.hooks.harness.id === "codex" ? inj?.extraArgs : undefined,
      })) {
        this.handleHarness(rt, ev, live, tools);
        if (ev.type === "text") talk = joinText(talk, ev.text);
        if (ev.type === "done") talk = ev.text || talk;
        if (ev.type === "error") throw new Error(ev.error);
      }
      live.finish(rt.abort.signal.aborted ? "stopped" : "done");
      this.hooks.onEvent({ type: "turn", session: rt.spark.id, payload: live.turn });
      const summary = toolActivityLine(tools);
      if (summary) rt.memory.append({ kind: "note", text: summary, seat: seatOf(this.hooks.harness.id) });
      rt.spark.summary = talk.trim().slice(0, 400) || rt.spark.summary;
      if (rt.spark.status === "merged") return;
      if (rt.spark.needsUser) {
        rt.spark.status = "needs_user";
        persistSpark(this.cfg.dataDir, rt.spark);
        this.hooks.onEvent({ type: "spark", session: rt.spark.id, payload: rt.spark });
        return;
      }
      if (rt.spark.hold) {
        rt.spark.status = "running";
        persistSpark(this.cfg.dataDir, rt.spark);
        this.hooks.onEvent({ type: "spark", session: rt.spark.id, payload: rt.spark });
        return;
      }
      rt.spark.status = "done";
      await this.merge(rt, rt.spark.summary ?? talk);
    } catch (err) {
      rt.spark.status = "error";
      rt.spark.summary = (err as Error).message;
      persistSpark(this.cfg.dataDir, rt.spark);
      this.hooks.onEvent({ type: "spark", session: rt.spark.id, payload: rt.spark });
    } finally {
      this.hooks.onIdle?.(rt.spark.id);
    }
  }

  private handleHarness(rt: SparkRuntime, ev: HarnessEvent, live: LiveTurn, tools: string[]): void {
    const applied = live.apply(ev);
    this.hooks.onEvent({ type: "turn", session: rt.spark.id, payload: live.turn });
    if (applied.step) {
      this.hooks.onEvent({ type: "step", session: rt.spark.id, payload: { turnId: live.id, step: applied.step } });
    }
    switch (ev.type) {
      case "text":
      case "thinking":
      case "model":
        this.hooks.onEvent({ type: "delta", session: rt.spark.id, payload: ev });
        break;
      case "tool":
        tools.push(ev.name);
        this.hooks.onEvent({ type: "tool", session: rt.spark.id, payload: ev });
        break;
      case "tool_result":
        break;
      case "seat":
        if (ev.status === "done" && ev.text) {
          const msg = rt.memory.append({ kind: "seat", text: ev.text, seat: ev.seat });
          this.hooks.onEvent({ type: "message", session: rt.spark.id, payload: msg });
        } else {
          this.hooks.onEvent({ type: "delta", session: rt.spark.id, payload: ev });
        }
        break;
      case "done":
        if (ev.text) {
          const msg = rt.memory.append({ kind: "talk", text: ev.text, seat: seatOf(this.hooks.harness.id), model: live.turn.model });
          this.hooks.onEvent({ type: "message", session: rt.spark.id, payload: msg });
          const plugin = this.views.get(rt.spark.view);
          const patch = plugin?.onEvent?.(rt.spark, { type: "done", text: ev.text });
          if (patch?.ui !== undefined) rt.spark.ui = patch.ui;
          if (patch?.flowStep) rt.spark.flowStep = patch.flowStep;
          if (patch?.note) {
            const note = rt.memory.append({ kind: "note", text: patch.note });
            this.hooks.onEvent({ type: "message", session: rt.spark.id, payload: note });
          }
          if (patch?.ui !== undefined || patch?.flowStep || patch?.note) {
            persistSpark(this.cfg.dataDir, rt.spark);
            this.hooks.onEvent({ type: "spark", session: rt.spark.id, payload: rt.spark });
          }
        }
        break;
      case "error":
        this.hooks.onEvent({ type: "error", session: rt.spark.id, payload: ev });
        break;
      default: {
        const _n: never = ev;
        void _n;
      }
    }
  }

  private async merge(rt: SparkRuntime, summary: string): Promise<void> {
    if (rt.spark.status === "merged") return;
    const plugin = this.views.get(rt.spark.view);
    const result = rt.spark.result ?? plugin?.result?.(rt.spark) ?? emptyResult(summary);
    result.summary = summary || result.summary;
    rt.spark.status = "merged";
    rt.spark.mergedAt = nowIso();
    rt.spark.summary = result.summary;
    rt.spark.result = result;
    rt.spark.flowStep = "result";
    persistSpark(this.cfg.dataDir, rt.spark);
    this.hooks.onEvent({ type: "spark", session: rt.spark.id, payload: rt.spark });
    this.hooks.onMerge(rt.spark, formatSparkResult(rt.spark, result), result);
  }
}

function shortWt(path: string): string {
  const parts = path.split("/");
  return `wt/${parts[parts.length - 1]}`;
}

function persistSpark(dataDir: string, spark: Spark): void {
  const dir = join(dataDir, "sparks", spark.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(spark, null, 2), "utf8");
}

export function loadSparkMeta(dataDir: string, id: string): Spark | null {
  for (const root of ["sparks", "forks"]) {
    const p = join(dataDir, root, id, "meta.json");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as Spark;
  }
  return null;
}

export function mergeMessage(spark: Spark, summary: string): Omit<Message, "i" | "size"> {
  return {
    kind: "merge",
    text: spark.result ? formatSparkResult(spark, spark.result) : `${spark.view} #${spark.seq} voltou · ${oneLine(summary)}`,
    date: nowIso(),
    sparkId: spark.id,
    seat: "claude",
  };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 220);
}

export type { SparkStatus, NeedsUser };
