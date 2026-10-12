import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seatOf as seatFromId } from "./agent";
import type { HarnessKind, NcliConfig } from "./config";
import type { CompactStatus, ContextSnapshot, Spark, HubEvent, MainAgent, Message, RecallEvent, SeatId, Turn, ViewInfo } from "./types";
import { contextSnapshot } from "./memory/context";
import type { ViewAction } from "./views/types";
import { Memory, mockCompressor, type Compressor } from "./memory/store";
import { spaceFor, SpaceRegistry } from "./memory/spaces";
import { haikuCompressor } from "./memory/compact";
import { compactSnapshot, cursorCompressor } from "./memory/cursor-compact";
import { factsOf, parseIds, wouldCycle } from "./memory/facts";
import { recallFromTool, verifyCitations } from "./memory/recall";
import { toolActivityLine } from "./memory/turn-log";
import type { Harness, HarnessEvent } from "./harness/types";
import { pickHarness } from "./harness/pick";
import { displaySeatModel } from "./harness/seat-model";
import { isQuotaError } from "./harness/quota";
import { isSeatKind, UsageBoard, type LimitPolicy } from "./harness/usage";
import { renderToolToFence } from "./live/parse";
import { LiveTurn } from "./live/turn";
import { joinText } from "./live/join-text";
import { ViewRegistry } from "./views/registry";
import { SparkManager, mergeMessage } from "./sparks/manager";
import { AutoGh, createPr, FixtureGh, RealGh, viewPrForHead, type GhClient } from "./gh/pr";
import { ghOpenTalk, isLonePrUrl, nowIso, parseViewLink } from "./util";
import { seedDemo } from "./demo";
import type { GitRunner } from "./sparks/worktree";
import { runNcli } from "./skills/scaffold";
import { defaultSkillsDir } from "./skills/catalog";
import { Bus } from "./bus/bus";
import { formatBusLine, isSeat, type BusLine } from "./bus/types";
import { McpGate } from "./mcp/auth";
import type { McpSession } from "./mcp/handle";
import { prepareSpawn } from "./mcp/inject";
import { sparkSkillPrompt } from "./views/manifest";
import { TurnQueue, type QueueMode } from "./queue/turn-queue";
import {
  alreadyInLog,
  defaultImportRoots,
  formatApply,
  formatPreview,
  Importer,
  listSessionFiles,
  parseImportArgv,
  rootFor,
  type ImportPreview,
  type ImportSource,
} from "./import";
import { detectClis, userHelp, type CliPresence } from "./ui/chrome";

export class Hub {
  readonly memory: Memory;
  readonly spaces: SpaceRegistry;
  readonly views: ViewRegistry;
  readonly sparks: SparkManager;
  readonly queue: TurnQueue;
  readonly usage: UsageBoard;
  readonly importer: Importer;
  lastImport: ImportPreview | null = null;
  importOffers: { source: ImportSource; sessions: number }[] = [];
  harness: Harness;
  readonly bus: Bus;
  readonly mcp = new McpGate();
  mcpUrl: string;
  model?: string;
  live: LiveTurn | null = null;
  compact: CompactStatus;
  private listeners = new Set<(ev: HubEvent) => void>;
  readonly compressor: Compressor;
  private turning = false;
  private abort: AbortController | null = null;
  private spawnMain: ReturnType<Hub["injectSpawn"]> | null = null;
  private spawnHarness = "";
  private recalls: RecallEvent[] = [];

  constructor(
    readonly cfg: NcliConfig,
    readonly viewsDir: string,
    readonly fixturesDir: string,
    harness?: Harness,
    git?: GitRunner,
    ghClient?: GhClient,
  ) {
    mkdirSync(cfg.dataDir, { recursive: true });
    this.mcpUrl = `http://127.0.0.1:${cfg.port}/mcp`;
    this.compact = compactSnapshot(cfg);
    this.compressor = pickCompressor(cfg, (ev) => {
      this.compact = { running: ev.running, lastNodes: ev.nodes, tokensToday: ev.tokensToday, budget: ev.budget, model: ev.model };
      this.emit({ type: "compact", compact: this.compact });
    });
    this.spaces = new SpaceRegistry({
      dataDir: cfg.dataDir,
      nodeBytes: cfg.nodeBytes,
      viewBytes: cfg.viewBytes,
      compressor: this.compressor,
      cwd: cfg.repo,
      pumpBatch: cfg.compactBatch,
      deferCutAfter: cfg.compactTries,
      compressTimeoutMs: cfg.compactTimeoutMs,
    });
    this.memory = this.spaces.current();
    this.memory.onChange = () => this.emit(contextSnapshot(this.memory, this.compact, this.cfg.userName, this.spaces.currentId));
    this.queue = new TurnQueue(cfg.dataDir);
    this.views = new ViewRegistry(viewsDir);
    this.harness = harness ?? pickHarness({ ...cfg, harness: readMainHarness(cfg) ?? cfg.harness });
    this.usage = new UsageBoard(cfg.dataDir, uniqueKinds([this.harness.id as HarnessKind, ...cfg.fallbackChain]));
    this.usage.onReset = (seat) => this.onUsageReset(seat);
    const defaults = defaultImportRoots();
    this.importer = new Importer(cfg.dataDir, {
      claude: cfg.importClaude || defaults.claude,
      codex: cfg.importCodex || defaults.codex,
      cursor: cfg.importCursor || defaults.cursor,
    });
    this.model = displaySeatModel(cfg, this.harness.id as HarnessKind);
    this.bus = new Bus({
      cfg,
      cwdFor: (spark) => (spark ? this.sparks.get(spark)?.worktree?.path ?? cfg.repo : cfg.repo),
      onLine: (line) => this.noteBus(line),
      onMcp: (name, args, from) => this.callMcp(name, args, from),
    });
    const gh = ghClient ?? pickGh(cfg, fixturesDir);
    this.sparks = new SparkManager(cfg, this.views, gh, {
      compressor: this.compressor,
      harness: this.harness,
      git,
      openPr: createPr,
      findPr: viewPrForHead,
      bus: this.bus,
      inject: (session, worktree) => this.injectSpawn(session, this.harness.id, worktree),
      onEvent: (ev) => {
        if (ev.type === "spark") this.emit({ type: "spark", spark: ev.payload as Spark });
        if (ev.type === "message") this.emit({ type: "message", session: ev.session, message: ev.payload as Message });
        if (ev.type === "tool") this.emit({ type: "tool", session: ev.session, name: String((ev.payload as { name?: string }).name ?? "tool"), input: ev.payload });
        if (ev.type === "delta") {
          const p = ev.payload as { text?: string; seat?: Message["seat"]; model?: string };
          this.emit({ type: "delta", session: ev.session, seat: p.seat, model: p.model, text: p.text ?? "" });
        }
        if (ev.type === "turn") this.emit({ type: "turn", session: ev.session, turn: ev.payload as Turn });
        if (ev.type === "step") {
          const p = ev.payload as { turnId: string; step: Turn["steps"][number] };
          this.emit({ type: "step", session: ev.session, turnId: p.turnId, step: p.step });
        }
      },
      onMerge: (spark, summary) => {
        const msg = this.memory.append(mergeMessage(spark, summary));
        this.emit({ type: "message", session: "main", message: msg });
        this.emitDebug();
        for (const item of this.queue.list(spark.id)) this.queue.remove(item.id);
        this.emitQueue();
      },
      onIdle: (id) => {
        void this.drainSession(id);
      },
    });
    this.views.onChange = (list) => this.emit({ type: "views", views: list });
  }

  switchMain(kind: HarnessKind): void {
    this.harness = pickHarness({ ...this.cfg, harness: kind });
    this.sparks.setHarness(this.harness);
    persistMainHarness(this.cfg.dataDir, kind);
    this.model = displaySeatModel(this.cfg, kind);
    this.spawnMain = null;
    this.spawnHarness = "";
    this.emit({ type: "main", main: this.mainAgent() });
  }

  mainAgent(): MainAgent {
    return {
      harness: this.harness.id as HarnessKind,
      model: this.model ?? displaySeatModel(this.cfg, this.harness.id as HarnessKind),
    };
  }

  mcpSession(who: { session: string; ticket?: string }): McpSession {
    return {
      session: who.session,
      ticket: who.ticket,
      sock: this.bus.socketPath,
      callControl: (name, args, from) => this.callMcp(name, args, from),
    };
  }

  injectSpawn(session: string, harness: string, worktree?: string, ticket?: string) {
    const token = this.mcp.mint(session, ticket);
    const view = this.sparks.get(session)?.spark.view;
    const pack = view ? this.views.packageOf(view) : undefined;
    return prepareSpawn({
      cfg: this.cfg,
      session,
      harness,
      worktree,
      ticket,
      token,
      mcpUrl: this.mcpUrl,
      addDir: pack ? pack.skillDirs : undefined,
      agentsMd: pack ? sparkSkillPrompt(pack) : undefined,
      extraMcp: pack?.manifest.mcp ? join(pack.dir, pack.manifest.mcp) : undefined,
    });
  }

  private mainSpawn() {
    if (this.spawnMain && this.spawnHarness === this.harness.id) return this.spawnMain;
    this.spawnMain = this.injectSpawn("main", this.harness.id);
    this.spawnHarness = this.harness.id;
    return this.spawnMain;
  }

  async start(): Promise<void> {
    await this.bus.listen();
    await this.views.loadAll();
    this.views.watch();
    this.sparks.restore();
    if (this.cfg.demo && this.memory.T === 0) {
      await seedDemo(this);
    }
    void this.memory.pump();
    this.emitDebug();
    this.emitQueue();
    this.emitUsage();
    if (!this.turning) void this.drainSession("main");
  }

  subscribe(fn: (ev: HubEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): {
    messages: Message[];
    sparks: Spark[];
    forks: Spark[];
    views: ViewInfo[];
    debug: ReturnType<Memory["debug"]>;
    context: ContextSnapshot;
    waiting: Spark[];
    main: MainAgent;
    turn: Turn | null;
    compact: CompactStatus;
    turning: boolean;
    queue: ReturnType<TurnQueue["list"]>;
    usage: ReturnType<UsageBoard["snapshot"]>;
    import: ImportPreview | null;
    clis: CliPresence;
  } {
    return {
      messages: this.memory.log,
      sparks: this.sparks.list(),
      forks: this.sparks.list(),
      views: this.views.list(),
      debug: this.memory.debug(),
      context: contextSnapshot(this.memory, this.compact, this.cfg.userName, this.spaces.currentId),
      waiting: this.sparks.waitingOnUser(),
      main: this.mainAgent(),
      turn: this.live?.turn ?? null,
      compact: this.compact,
      turning: this.turning,
      queue: this.queue.list(),
      usage: this.usageSnap(),
      import: this.lastImport,
      importOffers: this.importOffers,
      clis: detectClis(this.cfg),
    };
  }

  async send(text: string, opts: { mode?: QueueMode; session?: string } = {}): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const session = opts.session ?? "main";
    const mode = opts.mode ?? (this.isBusy(session) ? "steer" : "queue");
    if (session !== "main") {
      await this.sendSpark(session, trimmed, mode);
      return;
    }
    if (!this.turning && !this.ensureOpenSeat()) {
      this.park(session, trimmed, "queue");
      return;
    }
    if (this.turning) {
      const opened = await this.openLinks(trimmed);
      if (opened.length) return;
      this.park(session, trimmed, mode);
      return;
    }
    const user = this.memory.append({ kind: "user", text: trimmed });
    this.emit({ type: "message", session: "main", message: user });
    if (await this.slash(trimmed)) return;
    if (isLonePrUrl(trimmed)) {
      await this.openLinks(trimmed);
      return;
    }
    this.turning = true;
    this.abort = new AbortController();
    this.beginLive();
    try {
      if (parseViewLink(trimmed).length) await this.openLinks(trimmed);
      await this.turn(trimmed);
    } finally {
      this.turning = false;
      this.abort = null;
      if (this.live?.turn.status === "running") this.live.finish("done");
      if (this.live) this.emit({ type: "turn", session: "main", turn: this.live.turn });
      await this.drainSession("main");
    }
  }

  dropQueued(id: string): boolean {
    const ok = this.queue.remove(id);
    if (ok) this.emitQueue();
    return ok;
  }

  private isBusy(session: string): boolean {
    if (session === "main") return this.turning;
    return this.sparks.get(session)?.spark.status === "running";
  }

  private park(session: string, text: string, mode: QueueMode): void {
    const item = this.queue.enqueue({ session, text, mode });
    if (mode === "steer" && this.harness.steer?.(text)) {
      this.queue.remove(item.id);
    }
    this.emitQueue();
  }

  private async sendSpark(id: string, text: string, mode: QueueMode): Promise<void> {
    if (this.isBusy(id)) {
      this.park(id, text, mode);
      return;
    }
    await this.sparks.message(id, text);
  }

  private async drainSession(session: string): Promise<void> {
    if (this.isBusy(session)) return;
    const next = this.queue.takeNext(session);
    if (!next) return;
    this.emitQueue();
    await this.send(next.text, { session, mode: "queue" });
  }

  private emitQueue(): void {
    this.emit({ type: "queue", items: this.queue.list() });
  }

  stopTurn(session = "main"): boolean {
    if (session !== "main") {
      const rt = this.sparks.get(session);
      if (!rt) return false;
      rt.abort.abort();
      return true;
    }
    if (!this.turning) return false;
    this.abort?.abort();
    this.live?.finish("stopped");
    if (this.live) this.emit({ type: "turn", session: "main", turn: this.live.turn });
    const msg = this.memory.append({
      kind: "note",
      text: "turno interrompido",
      seat: seatFromId(this.harness.id),
    });
    this.emit({ type: "message", session: "main", message: msg });
    return true;
  }

  private async slash(text: string): Promise<boolean> {
    let note: string;
    if (text === "/help" || text === "/?" || text === "/ncli") {
      note = userHelp();
    } else {
      const m = text.match(/^\/ncli\s+(.+)$/);
      if (!m) return false;
      const argv = m[1].trim().split(/\s+/);
      try {
        if (argv[0] === "import") {
          note = this.runImport(argv.slice(1));
        } else {
          note = runNcli(argv, {
            viewsDir: this.viewsDir,
            acpDir: join(this.cfg.repo, "src/acp"),
            skillsDir: defaultSkillsDir(),
          });
          await this.views.loadAll();
          this.emit({ type: "views", views: this.views.list() });
        }
      } catch (err) {
        note = err instanceof Error ? err.message : String(err);
      }
    }
    const msg = this.memory.append({ kind: "note", text: note });
    this.emit({ type: "message", session: "main", message: msg });
    this.emitDebug();
    return true;
  }

  private runImport(argv: string[]): string {
    const cmd = parseImportArgv(argv);
    if (cmd.apply) return formatApply(this.applyImport(cmd.source, cmd.since));
    return formatPreview(this.previewImport(cmd.source, cmd.since), cmd.verbose);
  }

  previewImport(source: ImportPreview["source"], since?: string): ImportPreview {
    const preview = this.importer.preview(source, since);
    this.lastImport = preview;
    this.emit({ type: "import", preview });
    return preview;
  }

  offerFirstImport(): void {
    if (this.memory.T !== 0) return;
    const offers: { source: ImportSource; sessions: number }[] = [];
    let bestSource: ImportSource | null = null;
    let bestSessions = 0;
    for (const source of ["claude", "codex", "cursor"] as const) {
      const sessions = listSessionFiles(rootFor(source, this.importer.roots), source).length;
      if (!sessions) continue;
      offers.push({ source, sessions });
      if (sessions > bestSessions) {
        bestSessions = sessions;
        bestSource = source;
      }
    }
    this.importOffers = offers;
    if (!bestSource) return;
    this.lastImport = this.importer.preview(bestSource);
    this.emit({ type: "import", preview: this.lastImport, offers: this.importOffers });
  }

  applyImport(
    source: ImportPreview["source"],
    since?: string,
    opts: { surface?: boolean } = {},
  ): ReturnType<Importer["apply"]> {
    const surface = Boolean(opts.surface) && this.memory.T === 0;
    const result = this.importer.apply(
      source,
      since,
      (line) => {
        const mem = surface ? this.memory : this.memoryForImport(line.cwd);
        const msg = mem.append({
          kind: line.kind,
          text: line.text,
          seat: line.seat,
          date: line.at,
          hops: `import:${line.source}`,
        });
        if (mem === this.memory) this.emit({ type: "message", session: "main", message: msg });
        return msg;
      },
      (line) => alreadyInLog((surface ? this.memory : this.memoryForImport(line.cwd)).log, line),
    );
    this.lastImport = {
      ...result.preview,
      lines: [],
      newCount: 0,
      seenCount: result.preview.seenCount + result.applied,
    };
    this.emit({ type: "import", preview: this.lastImport, offers: this.importOffers });
    void this.memory.pump();
    this.emitDebug();
    return result;
  }

  seedViewSeq(view: string, last: number): void {
    this.sparks.seedViewSeq(view, last);
  }

  async openLinks(text: string): Promise<Spark[]> {
    const opened: Spark[] = [];
    for (const link of parseViewLink(text)) {
      try {
        const rt = await this.sparks.open(link.id, link.params);
        opened.push(rt.spark);
      } catch (err) {
        const text =
          link.id === "review" ? ghOpenTalk(link.params, err) : `Não abri ${link.id}. O hub segue no ar.`;
        const talk = this.memory.append({
          kind: "talk",
          text,
          seat: "ncli",
        });
        this.emit({ type: "message", session: "main", message: talk });
      }
    }
    return opened;
  }

  async ackSpark(id: string, summary?: string): Promise<void> {
    await this.sparks.finish(id, summary);
  }

  async actSpark(id: string, action: ViewAction): Promise<Spark> {
    return this.sparks.act(id, action);
  }

  private beginLive(): void {
    this.recalls = [];
    this.live = new LiveTurn(
      "main",
      seatFromId(this.harness.id),
      this.model ?? displaySeatModel(this.cfg, this.harness.id as HarnessKind),
    );
    this.emit({ type: "turn", session: "main", turn: this.live.turn });
  }

  private async turn(userText: string, retried = false): Promise<void> {
    if (retried || !this.live || this.live.turn.status !== "running") this.beginLive();
    void this.memory.pump();
    const ctx = this.spaces.assemble(this.cfg.repo);
    const inj = this.mainSpawn();
    const viewSnap = ctx.view;
    queueMicrotask(() => writeFileSync(join(this.cfg.dataDir, "last-view.txt"), viewSnap, "utf8"));
    let talk = "";
    const tools: string[] = [];
    const inbox = this.bus.drainPrompt("main");
    try {
      for await (const ev of this.harness.run({
        prompt: `${ctx.view}\n\n${inbox}${userText}`,
        system: ctx.system,
        cwd: this.cfg.repo,
        session: "main",
        signal: this.abort?.signal,
        mcpConfigPath: inj.mcpConfigPath,
        mcpServers: inj.mcpServers,
        addDir: this.harness.id === "claude" ? inj.addDir : undefined,
        extraArgs: this.harness.id === "codex" ? inj.extraArgs : undefined,
      })) {
        if (this.abort?.signal.aborted) break;
        if (ev.type === "error" && !retried && this.fallbackFrom(ev.error)) {
          await this.turn(userText, true);
          return;
        }
        this.handle(ev, tools);
        if (ev.type === "text") talk = joinText(talk, ev.text);
        if (ev.type === "done" && ev.text) talk = ev.text;
        if (ev.type === "tool" && ev.name === "ncli.render") {
          const inp = ev.input as { kind?: string; source?: string };
          if (inp?.kind && inp?.source) talk += `\n${renderToolToFence(inp.kind, inp.source)}`;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!retried && this.fallbackFrom(msg)) {
        await this.turn(userText, true);
        return;
      }
      throw err;
    }
    this.live.finish(this.abort?.signal.aborted ? "stopped" : "done");
    this.emit({ type: "turn", session: "main", turn: this.live.turn });
    this.persistToolSummary(tools);
    if (talk.trim() && !this.abort?.signal.aborted) {
      const already = this.memory.log.filter((m) => m.kind === "talk").at(-1)?.text === talk;
      if (!already) {
        const seat = seatFromId(this.harness.id);
        const citations = verifyCitations(talk, this.recalls, this.memory.log, this.spaces.currentId);
        const msg = this.memory.append({
          kind: "talk",
          text: talk,
          seat,
          model: this.live.turn.model,
          recall: citations.length ? citations : undefined,
        });
        this.emit({ type: "message", session: "main", message: msg });
        this.emit({
          type: "recall",
          session: "main",
          turnId: this.live.id,
          events: this.recalls,
          citations,
        });
      }
      await this.openLinks(talk);
    }
    void this.memory.pump();
    this.emitDebug();
  }

  private fallbackFrom(err: string): boolean {
    if (!isQuotaError(err)) return false;
    const current = this.harness.id as HarnessKind;
    this.usage.markLimited(current, err);
    this.emitUsage();
    const next = this.nextOpenSeat(current);
    if (!next) {
      const when = this.usage.limitOf(current).resetAt;
      const msg = this.memory.append({
        kind: "note",
        text: `${seatLabel(current)} bateu no limite. Sem seat livre${when ? ` · volta ${clockLabel(when)}` : ""}. A fila espera o reset.`,
        seat: seatFromId(current),
      });
      this.emit({ type: "message", session: "main", message: msg });
      return false;
    }
    this.switchMain(next);
    const msg = this.memory.append({
      kind: "note",
      text: `${seatLabel(current)} bateu no limite (quota/rate-limit). Passei o harness principal para ${next} e reintento o turno. Mesma memória, mesmas tools, mesmas skills.`,
      seat: seatFromId(next),
    });
    this.emit({ type: "message", session: "main", message: msg });
    this.emit({ type: "main", main: this.mainAgent() });
    return true;
  }

  setUsagePolicy(seat: HarnessKind, policy: LimitPolicy): ReturnType<UsageBoard["snapshot"]> {
    this.usage.setPolicy(seat, policy);
    this.emitUsage();
    return this.usageSnap();
  }

  onUsageReset(seat: HarnessKind): void {
    this.emitUsage();
    if (this.usage.limitOf(seat).policy === "snooze") return;
    const note = this.memory.append({
      kind: "note",
      text: `${seatLabel(seat)} voltou. Retomo a fila.`,
      seat: seatFromId(seat),
    });
    this.emit({ type: "message", session: "main", message: note });
    if (this.usage.limitOf(this.harness.id as HarnessKind).status === "limited") {
      this.switchMain(seat);
    }
    if (!this.turning) void this.drainSession("main");
  }

  private ensureOpenSeat(): boolean {
    const current = this.harness.id as HarnessKind;
    if (this.usage.limitOf(current).status === "ok") return true;
    const next = this.nextOpenSeat(current);
    if (!next) return false;
    this.switchMain(next);
    return true;
  }

  private nextOpenSeat(from: HarnessKind): HarnessKind | undefined {
    const found = this.usage.nextOpen(from, detectClis(this.cfg));
    if (found) return found;
    const backup = this.cfg.backupHarness;
    if (isSeatKind(backup) && backup !== from && backup !== "auto" && this.usage.limitOf(backup).status === "ok") {
      return backup;
    }
    return undefined;
  }

  private usageSnap() {
    return this.usage.snapshot(this.harness.id as HarnessKind, detectClis(this.cfg));
  }

  private emitUsage(): void {
    this.emit({ type: "usage", usage: this.usageSnap() });
  }

  async callMcp(name: string, args: Record<string, unknown>, from: string): Promise<string> {
    const denied = this.denySpace(name, from, args.space);
    if (denied) return denied;
    const mem = this.memoryForTool(from, args.space);
    const space = this.spaceIdOf(from);
    switch (name) {
      case "zoom": {
        const r = mem.zoom(Number(args.id), Number(args.n));
        if (!r.ok) return r.error;
        this.noteRecall("zoom", args, space);
        return r.lines.join("\n");
      }
      case "date": {
        const out = mem.dateOf(Number(args.id));
        if (out.startsWith("No message")) return out;
        this.noteRecall("date", args, space);
        return out;
      }
      case "recall": {
        const out = mem.recall(String(args.pattern ?? "")).join("\n") || "No match.";
        if (out === "No match." || out.startsWith("bad regex:")) return out;
        this.noteRecall("recall", args, space);
        return out;
      }
      case "supersede": {
        const old = parseIds(args.old);
        const reason = String(args.reason ?? "").trim();
        const neu = args.new === undefined || args.new === "" ? undefined : Number(args.new);
        if (!old.length || !reason) return "supersede needs old and reason.";
        if (old.some((id) => !mem.log[id])) return "no message to replace.";
        if (neu !== undefined && (!Number.isInteger(neu) || neu < 0 || !mem.log[neu])) {
          return "no successor message.";
        }
        if (neu !== undefined && old.some((id) => neu <= id)) {
          return "successor must be after the replaced message.";
        }
        if (neu !== undefined && wouldCycle(factsOf(mem.log), old, neu)) {
          return "supersede cycle.";
        }
        const note = mem.append({
          kind: "note",
          text: neu !== undefined
            ? `supersedes #${old.join(",#")} → #${neu}: ${reason}`
            : `supersedes #${old.join(",#")}: ${reason}`,
          supersedes: old,
          successor: neu,
          reason,
        });
        return `ok #${note.i}`;
      }
      case "ncli.render": {
        const kind = String(args.kind ?? "html");
        const source = String(args.source ?? "");
        return renderToolToFence(kind, source);
      }
      case "open_spark":
      case "open_fork": {
        const view = String(args.view ?? "");
        const params = paramsOf(args.params);
        const qs = new URLSearchParams(params).toString();
        const opened = await this.openLinks(`view://${view}${qs ? `?${qs}` : ""}`);
        return opened.map((s) => `${s.id} ${s.status}`).join("\n") || "not opened";
      }
      case "close_spark":
      case "close_fork":
        await this.ackSpark(String(args.id ?? ""), args.summary ? String(args.summary) : undefined);
        return "ok";
      case "list_views":
        return JSON.stringify(this.views.list().map((v) => ({ id: v.id, label: v.label })));
      case "list_sparks":
      case "list_forks":
        return JSON.stringify(this.sparks.list().map((s) => ({ id: s.id, view: s.view, status: s.status })));
      case "switch_harness": {
        const kind = String(args.harness ?? "") as HarnessKind;
        if (kind !== "claude" && kind !== "codex" && kind !== "cursor" && kind !== "mock") {
          return `harness desconhecido: ${kind}`;
        }
        this.switchMain(kind);
        return `harness=${this.harness.id}`;
      }
      case "budget": {
        const d = mem.debug();
        return JSON.stringify({ bytes: d.bytes, budget: d.budget, T: d.T, levels: d.levels });
      }
      default:
        return `unknown tool ${name}`;
    }
  }

  private handle(ev: HarnessEvent, tools: string[]): void {
    if (ev.type === "model") {
      this.model = ev.model;
      this.emit({ type: "main", main: this.mainAgent() });
    }
    const applied = this.live?.apply(ev);
    const streamy = ev.type === "text" || ev.type === "thinking";
    const firstChunk = Boolean(applied?.step && applied.delta && applied.step.text === applied.delta);
    if (this.live && !streamy) this.emit({ type: "turn", session: "main", turn: this.live.turn });
    if (applied?.step && (!streamy || firstChunk)) {
      this.emit({ type: "step", session: "main", turnId: this.live!.id, step: applied.step });
    }
    if (applied?.delta) {
      this.emit({
        type: "delta",
        session: "main",
        seat: this.live?.turn.seat,
        model: this.live?.turn.model,
        text: applied.delta,
        turnId: this.live?.id,
        stepId: applied.step?.id,
      });
    }
    switch (ev.type) {
      case "text":
      case "thinking":
      case "model":
        break;
      case "tool": {
        tools.push(ev.name);
        this.emit({ type: "tool", session: "main", name: ev.name, input: ev.input });
        break;
      }
      case "tool_result":
        break;
      case "seat":
        if (ev.status === "done" && ev.text) {
          const msg = this.memory.append({ kind: "seat", text: ev.text, seat: ev.seat, model: this.live?.turn.model });
          this.emit({ type: "message", session: "main", message: msg });
        }
        break;
      case "done":
        break;
      case "error":
        this.emit({ type: "error", error: ev.error });
        break;
      default: {
        const _n: never = ev;
        void _n;
      }
    }
  }

  private spaceIdOf(from: string): string {
    return this.sparks.get(from) ? `spark:${from}` : this.spaces.currentId;
  }

  private noteRecall(name: string, args: Record<string, unknown>, space: string): void {
    const ev = recallFromTool(name, args, this.live?.id ?? "", nowIso(), space);
    if (ev) this.recalls.push(ev);
  }

  private persistToolSummary(tools: string[]): void {
    const text = toolActivityLine(tools);
    if (!text) return;
    const msg = this.memory.append({
      kind: "note",
      text,
      seat: seatFromId(this.harness.id),
    });
    this.emit({ type: "message", session: "main", message: msg });
  }

  private emit(ev: HubEvent): void {
    for (const fn of this.listeners) fn(ev);
  }

  private emitDebug(): void {
    const d = this.memory.debug();
    this.emit({
      type: "debug",
      session: "main",
      lines: d.lines,
      bytes: d.bytes,
      budget: d.budget,
      levels: d.levels,
    });
  }

  private memoryForImport(cwd?: string): Memory {
    if (!cwd) return this.spaces.inbox();
    return this.spaces.of(spaceFor(cwd));
  }

  private denySpace(name: string, from: string, space: unknown): string | undefined {
    if (typeof space !== "string" || !space) return undefined;
    if (name === "supersede") return "supersede does not take space.";
    if (this.allowsSpace(from, space)) return undefined;
    return `space ${space} is not this session.`;
  }

  private allowsSpace(from: string, space: string): boolean {
    const sparkRt = this.sparks.get(from);
    if (space === "global" || space === "current" || space === "main") return true;
    if (!sparkRt && space === this.spaces.currentId) return true;
    return Boolean(sparkRt && (space === `spark:${from}` || space === from));
  }

  private memoryForTool(from: string, space: unknown): Memory {
    const sparkRt = this.sparks.get(from);
    const own = sparkRt?.memory ?? this.memory;
    if (typeof space !== "string" || !space) return own;
    if (space === "global") return this.spaces.global();
    return own;
  }

  close(): void {
    for (const rt of this.sparks.runtimes.values()) rt.abort.abort();
    this.usage.close();
    this.views.close();
    this.bus.close();
  }

  private noteBus(line: BusLine): void {
    if (line.kind === "event") return;
    const seat = isSeat(line.from) ? line.from : "claude";
    const msg = this.memory.append({
      kind: "bus",
      text: formatBusLine(line),
      seat,
      to: line.to,
    });
    this.emit({ type: "message", session: "main", message: msg });
  }
}

function pickCompressor(cfg: NcliConfig, onProgress?: (ev: { running: boolean; nodes: number; tokensToday: number; budget: number; model: string }) => void): Compressor {
  switch (cfg.compactBackend) {
    case "mock":
      return mockCompressor();
    case "claude":
      return haikuCompressor(cfg);
    case "cursor":
      return cursorCompressor(cfg, undefined, onProgress);
    case "auto":
      return cfg.harness === "mock" ? mockCompressor() : cursorCompressor(cfg, undefined, onProgress);
    default: {
      const _n: never = cfg.compactBackend;
      return mockCompressor();
    }
  }
}

function pickGh(cfg: NcliConfig, fixturesDir: string): GhClient {
  const fixtures = new FixtureGh(fixturesDir);
  if (cfg.ghMode === "mock") return fixtures;
  if (cfg.ghMode === "real") return new RealGh(cfg.repo);
  return new AutoGh(new RealGh(cfg.repo), fixtures);
}

function seatOf(id: string): SeatId {
  return seatFromId(id);
}

function paramsOf(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === "string") return Object.fromEntries(new URLSearchParams(raw));
  if (typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
    return out;
  }
  return {};
}

function uniqueKinds(list: HarnessKind[]): HarnessKind[] {
  return [...new Set(list.filter(isSeatKind))];
}

function seatLabel(kind: HarnessKind): string {
  if (kind === "claude") return "Claude";
  if (kind === "codex") return "Codex";
  if (kind === "cursor") return "Cursor";
  if (kind === "mock") return "mock";
  const _n: never = kind;
  return _n;
}

function clockLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function persistMainHarness(dataDir: string, kind: HarnessKind): void {
  writeFileSync(join(dataDir, "main-harness"), kind, "utf8");
}

function readMainHarness(cfg: NcliConfig): HarnessKind | undefined {
  const path = join(cfg.dataDir, "main-harness");
  if (!existsSync(path)) return undefined;
  const kind = readFileSync(path, "utf8").trim() as HarnessKind;
  if (kind === "claude" || kind === "codex" || kind === "cursor" || kind === "mock") return kind;
  return undefined;
}
