import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Spark, SparkStatus, Message, NeedsUser } from "../types";
import type { NcliConfig } from "../config";
import type { Harness, HarnessEvent } from "../harness/types";
import type { ViewAction } from "../views/types";
import type { ViewRegistry } from "../views/registry";
import { agentForStep, assertRunnable, availableHarnesses, emptyResult, formatSparkResult, sparkSkillPrompt, type ManifestHarness, type SparkResult } from "../views/manifest";
import { pickHarness } from "../harness/pick";
import type { GhClient } from "../gh/pr";
import { Memory, type Compressor } from "../memory/store";
import { assemble } from "../memory/assemble";
import { toolActivityLine } from "../memory/turn-log";
import { addWorktree, archiveWorktree, inspectWorktree, realGit, type ArchiveResult, type GitRunner, type WorktreeHandle } from "./worktree";
import { planShip, runShip, type FindPr, type OpenPr, type ShipPlan, type ShipResult } from "./ship";
import { nowIso, sameReviewParams } from "../util";
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
  harnessFor?: (id: ManifestHarness) => Harness | undefined;
  git?: GitRunner;
  worktreeBase?: string;
  openPr?: OpenPr;
  findPr?: FindPr;
  bus?: Bus;
  inject?: (session: string, worktree?: string) => SpawnInject;
}

const OPEN_STATUS = new Set<SparkStatus>(["running", "needs_user"]);

export class SparkManager {
  readonly runtimes = new Map<string, SparkRuntime>();
  private seqByView = new Map<string, number>();
  private shipping = new Map<string, Promise<ShipResult>>();
  private readonly seats = new Map<string, Harness>();

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
      const home = join(root, name);
      const memory = new Memory({
        dir: home,
        nodeBytes: this.cfg.nodeBytes,
        viewBytes: this.cfg.viewBytes,
        compressor: this.hooks.compressor,
        pumpBatch: this.cfg.compactBatch,
        compactJobs: this.cfg.compactJobs,
        deferCutAfter: this.cfg.compactTries,
        compressTimeoutMs: this.cfg.compactTimeoutMs,
      });
      const rt: SparkRuntime = {
        spark: meta,
        memory,
        abort: new AbortController(),
        worktree: restoreWorktree(home, meta),
        seats: {},
      };
      this.watchAbort(rt);
      this.runtimes.set(meta.id, rt);
    }
    }
  }

  seedViewSeq(view: string, last: number): void {
    this.seqByView.set(view, last);
  }

  list(): Spark[] {
    return [...this.runtimes.values()].map((r) => r.spark);
  }

  /** Includes closed and merged sparks so shutdown flushes late appends. */
  sparkMemories(): Memory[] {
    return [...this.runtimes.values()].map((rt) => rt.memory);
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

  findOpen(viewId: string, params: Record<string, string>): SparkRuntime | undefined {
    return [...this.runtimes.values()].find(
      (r) => OPEN_STATUS.has(r.spark.status) && this.sameSpark(viewId, params, r),
    );
  }

  private findSettled(viewId: string, params: Record<string, string>): SparkRuntime | undefined {
    const hits = [...this.runtimes.values()].filter(
      (r) => !OPEN_STATUS.has(r.spark.status) && this.sameSpark(viewId, params, r),
    );
    hits.sort((a, b) => b.spark.seq - a.spark.seq);
    return hits[0];
  }

  private sameSpark(viewId: string, params: Record<string, string>, rt: SparkRuntime): boolean {
    if (rt.spark.view !== viewId) return false;
    if (viewId === "review") return sameReviewParams(rt.spark.params, params);
    return new URLSearchParams(rt.spark.params).toString() === new URLSearchParams(params).toString();
  }

  async open(viewId: string, params: Record<string, string>): Promise<SparkRuntime> {
    const plugin = this.views.get(viewId);
    if (!plugin) throw new Error(`view desconhecida: ${viewId}`);
    const pack = this.views.packageOf(viewId);
    if (pack) assertRunnable(pack.manifest, availableHarnesses({ harness: this.cfg.harness }));
    const parsed = plugin.parseLink?.(params) ?? params;
    const existing = this.findOpen(viewId, parsed);
    if (existing) {
      this.hooks.onEvent({ type: "spark", session: existing.spark.id, payload: existing.spark });
      return existing;
    }
    const settled = this.findSettled(viewId, parsed);
    if (settled) return this.reopen(settled, parsed);
    const created = await plugin.createSpark(parsed, {
      dataDir: this.cfg.dataDir,
      repo: this.cfg.repo,
      fetchPr: (pr, spec) => this.gh.view(pr, spec),
    });
    const seq = (this.seqByView.get(viewId) ?? 0) + 1;
    this.seqByView.set(viewId, seq);
    const id = `${viewId}-${seq}`;
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
        worktree = await addWorktree(created.repo ?? this.cfg.repo, id, this.hooks.git, this.hooks.worktreeBase);
        spark.worktree = shortWt(worktree.path);
        spark.branch = worktree.branch;
        spark.repo = worktree.repo;
      } catch (err) {
        spark.status = "error";
        spark.summary = (err as Error).message;
        const failed = this.bind(spark, undefined);
        this.runtimes.set(id, failed);
        persistRuntime(failed);
        this.hooks.onEvent({ type: "spark", session: id, payload: spark });
        throw err;
      }
    }
    const rt = this.bind(spark, worktree);
    this.runtimes.set(id, rt);
    persistRuntime(rt);
    this.hooks.onEvent({ type: "spark", session: id, payload: spark });
    await this.maybeArchiveMerged(rt, false);
    void this.runTurn(rt, created.prompt, true);
    return rt;
  }

  private async reopen(rt: SparkRuntime, parsed: Record<string, string>): Promise<SparkRuntime> {
    const plugin = this.views.get(rt.spark.view);
    if (!plugin) throw new Error(`view desconhecida: ${rt.spark.view}`);
    const created = await plugin.createSpark(parsed, {
      dataDir: this.cfg.dataDir,
      repo: this.cfg.repo,
      fetchPr: (pr, spec) => this.gh.view(pr, spec),
    });
    rt.abort = new AbortController();
    this.watchAbort(rt);
    rt.spark.status = created.needsUser ? "needs_user" : "running";
    rt.spark.needsUser = created.needsUser;
    rt.spark.hold = created.hold;
    rt.spark.mergedAt = undefined;
    rt.spark.title = created.title;
    rt.spark.ui = created.ui ?? rt.spark.ui;
    rt.spark.flowStep = created.flowStep ?? rt.spark.flowStep;
    if (created.needsWorktree) {
      try {
        const worktree = await addWorktree(
          created.repo ?? rt.spark.repo ?? this.cfg.repo,
          rt.spark.id,
          this.hooks.git,
          this.hooks.worktreeBase,
        );
        rt.worktree = worktree;
        rt.spark.worktree = shortWt(worktree.path);
        rt.spark.branch = worktree.branch;
        rt.spark.repo = worktree.repo;
      } catch (err) {
        rt.spark.status = "error";
        rt.spark.summary = (err as Error).message;
        rt.worktree = undefined;
        persistRuntime(rt);
        this.hooks.onEvent({ type: "spark", session: rt.spark.id, payload: rt.spark });
        throw err;
      }
    }
    persistRuntime(rt);
    this.hooks.onEvent({ type: "spark", session: rt.spark.id, payload: rt.spark });
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
    persistRuntime(rt);
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
      fetchPr: (pr, spec) => this.gh.view(pr, spec),
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
    persistRuntime(rt);
    this.hooks.onEvent({ type: "spark", session: id, payload: rt.spark });
    await this.maybeArchiveMerged(rt);
    if (result?.ask) {
      rt.spark.status = "running";
      rt.spark.needsUser = undefined;
      persistRuntime(rt);
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
    await this.dropWorktree(id);
  }

  async close(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.abort.abort();
    if (rt.spark.status !== "merged") {
      await this.merge(rt, rt.spark.summary ?? "fechado");
    }
    await this.maybeArchiveMerged(rt);
    await this.dropWorktree(id);
  }

  async maybeArchiveMerged(rt: SparkRuntime, fresh = true): Promise<void> {
    const pr = rt.spark.params.pr;
    if (!pr) return;
    try {
      const ui =
        rt.spark.ui && typeof rt.spark.ui === "object"
          ? (rt.spark.ui as { prState?: string; head?: string })
          : undefined;
      let state = ui?.prState;
      let head = ui?.head;
      if (fresh || !state) {
        const info = await this.gh.view(pr, {
          owner: rt.spark.params.owner,
          repo: rt.spark.params.repo,
        });
        state = info.state;
        head = info.headOid;
        if (ui) {
          ui.prState = state;
          if (head) ui.head = head;
        }
      }
      if (state !== "MERGED" || !rt.worktree) return;
      await this.archive(rt.spark.id, false);
    } catch {
      return;
    }
  }

  async shipPlanOf(id: string): Promise<ShipPlan> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(`spark ${id} não existe`);
    if (!rt.worktree) return planShip({ dirty: false, unpushed: false, files: [] }, rt.spark.title);
    return planShip(await inspectWorktree(rt.worktree, this.hooks.git ?? realGit), rt.spark.title);
  }

  async ship(id: string): Promise<ShipResult> {
    const pending = this.shipping.get(id);
    if (pending) return pending;
    const work = this.shipOnce(id).finally(() => this.shipping.delete(id));
    this.shipping.set(id, work);
    return work;
  }

  private async shipOnce(id: string): Promise<ShipResult> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(`spark ${id} não existe`);
    if (!rt.worktree) {
      return { ok: false, plan: planShip({ dirty: false, unpushed: false, files: [] }, rt.spark.title), error: "sem worktree" };
    }
    if (!this.hooks.openPr) {
      return { ok: false, plan: await this.shipPlanOf(id), error: "sem gh" };
    }
    const result = await runShip({
      handle: rt.worktree,
      title: rt.spark.title,
      git: this.hooks.git ?? realGit,
      openPr: this.hooks.openPr,
      findPr: this.hooks.findPr,
    });
    if (result.ok && result.url) {
      const num = result.url.match(/\/pull\/(\d+)/)?.[1];
      if (num) rt.spark.params.pr = num;
      const note = rt.memory.append({ kind: "note", text: `PR ${result.url}` });
      persistRuntime(rt);
      this.hooks.onEvent({ type: "spark", session: id, payload: rt.spark });
      this.hooks.onEvent({ type: "message", session: id, payload: note });
    }
    return result;
  }

  async archive(id: string, force = false): Promise<ArchiveResult | undefined> {
    const rt = this.runtimes.get(id);
    if (!rt) return undefined;
    this.harnessFor(rt).release?.(rt.spark.id);
    if (!rt.worktree) return undefined;
    const result = await archiveWorktree(rt.worktree, this.hooks.git ?? realGit, { force });
    if (result.ok) {
      rt.worktree = undefined;
      rt.spark.worktree = "arquivo";
      persistRuntime(rt);
      this.hooks.onEvent({ type: "spark", session: id, payload: rt.spark });
      return result;
    }
    const why = result.blocked === "dirty" ? result.status.files.join(", ") || "arquivos sujos" : "commits locais";
    rt.memory.append({
      kind: "note",
      text: `worktree ${result.blocked}: ${why}. Fecha de novo com force para arquivar.`,
    });
    persistRuntime(rt);
    this.hooks.onEvent({ type: "spark", session: id, payload: rt.spark });
    return result;
  }

  private async dropWorktree(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt?.worktree) return;
    await this.archive(id, true);
  }

  private harnessFor(rt: SparkRuntime): Harness {
    const pack = this.views.packageOf(rt.spark.view);
    const wanted = pack ? agentForStep(pack.manifest, rt.spark.flowStep)?.harness : undefined;
    if (!wanted || wanted === "auto" || wanted === this.hooks.harness.id) return this.hooks.harness;
    const provided = this.hooks.harnessFor?.(wanted);
    if (provided) return provided;
    if (this.hooks.harness.id === "mock") return this.hooks.harness;
    const cached = this.seats.get(wanted);
    if (cached) return cached;
    const made = pickHarness({ ...this.cfg, harness: wanted });
    this.seats.set(wanted, made);
    return made;
  }

  private bind(spark: Spark, worktree: WorktreeHandle | undefined): SparkRuntime {
    const rt: SparkRuntime = {
      spark,
      memory: new Memory({
        dir: join(this.cfg.dataDir, "sparks", spark.id),
        nodeBytes: this.cfg.nodeBytes,
        viewBytes: this.cfg.viewBytes,
        compressor: this.hooks.compressor,
        pumpBatch: this.cfg.compactBatch,
        compactJobs: this.cfg.compactJobs,
        deferCutAfter: this.cfg.compactTries,
        compressTimeoutMs: this.cfg.compactTimeoutMs,
      }),
      abort: new AbortController(),
      worktree,
      seats: {},
    };
    this.watchAbort(rt);
    return rt;
  }

  private watchAbort(rt: SparkRuntime): void {
    rt.abort.signal.addEventListener("abort", () => {
      this.harnessFor(rt).release?.(rt.spark.id);
    });
  }

  private async runTurn(rt: SparkRuntime, userText: string, isBoot: boolean): Promise<void> {
    void rt.memory.pump();
    const pack = this.views.packageOf(rt.spark.view);
    const harness = this.harnessFor(rt);
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
      const live = new LiveTurn(rt.spark.id, seatOf(harness.id));
      const tools: string[] = [];
      this.hooks.onEvent({ type: "turn", session: rt.spark.id, payload: live.turn });
      const model = pack ? agentForStep(pack.manifest, rt.spark.flowStep)?.model : undefined;
      for await (const ev of harness.run({
        prompt: `${ctx.view}\n\n${inbox}${userText}`,
        system: ctx.system,
        cwd: rt.worktree?.path ?? this.cfg.repo,
        session: rt.spark.id,
        signal: rt.abort.signal,
        mcpConfigPath: inj?.mcpConfigPath,
        mcpServers: inj?.mcpServers,
        addDir: pack?.skillDirs ?? [],
        extraArgs: harness.id === "codex" ? inj?.extraArgs : undefined,
        model,
      })) {
        this.handleHarness(rt, ev, live, tools);
        if (ev.type === "text") talk = joinText(talk, ev.text);
        if (ev.type === "done") talk = ev.text || talk;
        if (ev.type === "error") throw new Error(ev.error);
      }
      live.finish(rt.abort.signal.aborted ? "stopped" : "done");
      this.hooks.onEvent({ type: "turn", session: rt.spark.id, payload: live.turn });
      const summary = toolActivityLine(tools);
      if (summary) rt.memory.append({ kind: "note", text: summary, seat: seatOf(harness.id) });
      rt.spark.summary = talk.trim().slice(0, 400) || rt.spark.summary;
      if (rt.spark.status === "merged") return;
      if (rt.spark.needsUser) {
        rt.spark.status = "needs_user";
        persistRuntime(rt);
        this.hooks.onEvent({ type: "spark", session: rt.spark.id, payload: rt.spark });
        return;
      }
      if (rt.spark.hold) {
        rt.spark.status = "running";
        persistRuntime(rt);
        this.hooks.onEvent({ type: "spark", session: rt.spark.id, payload: rt.spark });
        return;
      }
      rt.spark.status = "done";
      await this.merge(rt, rt.spark.summary ?? talk);
    } catch (err) {
      if (rt.spark.status === "merged") return;
      rt.spark.status = "error";
      rt.spark.summary = (err as Error).message;
      persistRuntime(rt);
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
          const msg = rt.memory.append({ kind: "talk", text: ev.text, seat: seatOf(this.harnessFor(rt).id), model: live.turn.model });
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
            persistRuntime(rt);
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
    this.harnessFor(rt).release?.(rt.spark.id);
    rt.spark.mergedAt = nowIso();
    rt.spark.summary = result.summary;
    rt.spark.result = result;
    rt.spark.flowStep = "result";
    persistRuntime(rt);
    this.hooks.onEvent({ type: "spark", session: rt.spark.id, payload: rt.spark });
    this.hooks.onMerge(rt.spark, formatSparkResult(rt.spark, result), result);
  }
}

function shortWt(path: string): string {
  const parts = path.split("/");
  return `wt/${parts[parts.length - 1]}`;
}

function persistRuntime(rt: SparkRuntime): void {
  const dir = rt.memory.dir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(rt.spark, null, 2), "utf8");
  const file = join(dir, "worktree.json");
  if (rt.worktree && rt.spark.worktree !== "arquivo" && rt.spark.worktree !== "sem wt") {
    const stored: WorktreeHandle = {
      path: rt.worktree.path,
      branch: rt.worktree.branch,
      repo: rt.worktree.repo,
      baseDir: rt.worktree.baseDir,
    };
    writeFileSync(file, JSON.stringify(stored, null, 2), "utf8");
    return;
  }
  if (existsSync(file)) rmSync(file);
}

function restoreWorktree(home: string, meta: Spark): WorktreeHandle | undefined {
  if (!meta.worktree || meta.worktree === "arquivo" || meta.worktree === "sem wt") return undefined;
  const stored = readWorktreeFile(home);
  if (stored && isWorktreeDir(stored.path)) return stored;
  if (!meta.repo || !meta.branch) return undefined;
  const baseDir = join(resolve(meta.repo), ".ncli", "wt");
  const path = join(baseDir, meta.id);
  if (!isWorktreeDir(path)) return undefined;
  return { path, branch: meta.branch, repo: resolve(meta.repo), baseDir };
}

function readWorktreeFile(home: string): WorktreeHandle | undefined {
  const file = join(home, "worktree.json");
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<WorktreeHandle>;
    if (!raw.path || !raw.branch || !raw.repo || !raw.baseDir) return undefined;
    return { path: raw.path, branch: raw.branch, repo: raw.repo, baseDir: raw.baseDir };
  } catch {
    return undefined;
  }
}

function isWorktreeDir(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
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
