import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessKind, NcliConfig } from "./config";
import type { Fork, HubEvent, Message, SeatId, ViewInfo } from "./types";
import type { ViewAction } from "./views/types";
import { Memory, mockCompressor, type Compressor } from "./memory/store";
import { haikuCompressor } from "./memory/compact";
import { cursorCompressor } from "./memory/cursor-compact";
import { assemble } from "./memory/assemble";
import type { Harness, HarnessEvent } from "./harness/types";
import { pickHarness } from "./harness/pick";
import { isQuotaError } from "./harness/quota";
import { renderToolToFence } from "./live/parse";
import { ViewRegistry } from "./views/registry";
import { ForkManager, mergeMessage } from "./forks/manager";
import { AutoGh, FixtureGh, RealGh, type GhClient } from "./gh/pr";
import { parseViewLink } from "./util";
import { seedDemo } from "./demo";
import type { GitRunner } from "./forks/worktree";
import { runNcli } from "./skills/scaffold";
import { defaultSkillsDir } from "./skills/catalog";
import { Bus } from "./bus/bus";
import { formatBusLine, isSeat, type BusLine } from "./bus/types";
import { prepareSpawn } from "./mcp/inject";

export class Hub {
  readonly memory: Memory;
  readonly views: ViewRegistry;
  readonly forks: ForkManager;
  harness: Harness;
  readonly bus: Bus;
  private listeners = new Set<(ev: HubEvent) => void>;
  readonly compressor: Compressor;
  private turning = false;

  constructor(
    readonly cfg: NcliConfig,
    readonly viewsDir: string,
    readonly fixturesDir: string,
    harness?: Harness,
    git?: GitRunner,
  ) {
    mkdirSync(cfg.dataDir, { recursive: true });
    this.compressor = pickCompressor(cfg);
    this.memory = new Memory({
      dir: join(cfg.dataDir, "main"),
      nodeBytes: cfg.nodeBytes,
      viewBytes: cfg.viewBytes,
      compressor: this.compressor,
    });
    this.views = new ViewRegistry(viewsDir);
    this.harness = harness ?? pickHarness({ ...cfg, harness: readMainHarness(cfg) ?? cfg.harness });
    this.bus = new Bus({
      cfg,
      cwdFor: (fork) => (fork ? this.forks.get(fork)?.worktree?.path ?? cfg.repo : cfg.repo),
      onLine: (line) => this.noteBus(line),
      onMcp: (name, args, from) => this.callMcp(name, args, from),
    });
    const gh = pickGh(cfg, fixturesDir);
    this.forks = new ForkManager(cfg, this.views, gh, {
      compressor: this.compressor,
      harness: this.harness,
      git,
      bus: this.bus,
      onEvent: (ev) => {
        if (ev.type === "fork") this.emit({ type: "fork", fork: ev.payload as Fork });
        if (ev.type === "message") this.emit({ type: "message", session: ev.session, message: ev.payload as Message });
        if (ev.type === "tool") this.emit({ type: "tool", session: ev.session, name: String((ev.payload as { name?: string }).name ?? "tool"), input: ev.payload });
        if (ev.type === "delta") {
          const p = ev.payload as { text?: string; seat?: Message["seat"] };
          this.emit({ type: "delta", session: ev.session, seat: p.seat, text: p.text ?? "" });
        }
      },
      onMerge: (fork, summary) => {
        const msg = this.memory.append(mergeMessage(fork, summary));
        this.emit({ type: "message", session: "main", message: msg });
        this.emitDebug();
      },
    });
    this.views.onChange = (list) => this.emit({ type: "views", views: list });
  }

  switchMain(kind: HarnessKind): void {
    this.harness = pickHarness({ ...this.cfg, harness: kind });
    this.forks.setHarness(this.harness);
    persistMainHarness(this.cfg.dataDir, kind);
  }

  async start(): Promise<void> {
    await this.bus.listen();
    await this.views.loadAll();
    this.views.watch();
    this.forks.restore();
    if (this.cfg.demo && this.memory.T === 0) {
      await seedDemo(this);
    }
    await this.memory.pump();
    this.emitDebug();
  }

  subscribe(fn: (ev: HubEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): {
    messages: Message[];
    forks: Fork[];
    views: ViewInfo[];
    debug: ReturnType<Memory["debug"]>;
    waiting: Fork[];
  } {
    return {
      messages: this.memory.log,
      forks: this.forks.list(),
      views: this.views.list(),
      debug: this.memory.debug(),
      waiting: this.forks.waitingOnUser(),
    };
  }

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const user = this.memory.append({ kind: "user", text: trimmed });
    this.emit({ type: "message", session: "main", message: user });
    if (await this.slash(trimmed)) return;
    await this.openLinks(trimmed);
    if (this.turning) return;
    this.turning = true;
    try {
      await this.turn(trimmed);
    } finally {
      this.turning = false;
    }
  }

  private async slash(text: string): Promise<boolean> {
    const m = text.match(/^\/ncli\s+(.+)$/);
    if (!m) return false;
    let note: string;
    try {
      note = runNcli(m[1].trim().split(/\s+/), {
        viewsDir: this.viewsDir,
        acpDir: join(this.cfg.repo, "src/acp"),
        skillsDir: defaultSkillsDir(),
      });
    } catch (err) {
      note = err instanceof Error ? err.message : String(err);
    }
    await this.views.loadAll();
    this.emit({ type: "views", views: this.views.list() });
    const msg = this.memory.append({ kind: "note", text: note });
    this.emit({ type: "message", session: "main", message: msg });
    this.emitDebug();
    return true;
  }

  seedViewSeq(view: string, last: number): void {
    this.forks.seedViewSeq(view, last);
  }

  async openLinks(text: string): Promise<Fork[]> {
    const opened: Fork[] = [];
    for (const link of parseViewLink(text)) {
      const rt = await this.forks.open(link.id, link.params);
      opened.push(rt.fork);
    }
    return opened;
  }

  async ackFork(id: string, summary?: string): Promise<void> {
    await this.forks.finish(id, summary);
  }

  async actFork(id: string, action: ViewAction): Promise<Fork> {
    return this.forks.act(id, action);
  }

  private async turn(userText: string, retried = false): Promise<void> {
    void this.memory.pump();
    const ctx = assemble(this.memory);
    const inj = prepareSpawn({ cfg: this.cfg, session: "main", harness: this.harness.id });
    writeFileSync(join(this.cfg.dataDir, "last-view.txt"), ctx.view, "utf8");
    let talk = "";
    const tools: string[] = [];
    const inbox = this.bus.drainPrompt("main");
    try {
      for await (const ev of this.harness.run({
        prompt: `${inbox}${ctx.view}\n\n${userText}`,
        system: ctx.system,
        cwd: this.cfg.repo,
        session: "main",
        mcpConfigPath: inj.mcpConfigPath,
        mcpServers: inj.mcpServers,
        addDir: this.harness.id === "claude" ? inj.addDir : undefined,
        extraArgs: this.harness.id === "codex" ? inj.extraArgs : undefined,
      })) {
        if (ev.type === "error" && !retried && this.fallbackFrom(ev.error)) {
          await this.turn(userText, true);
          return;
        }
        this.handle(ev, tools);
        if (ev.type === "text") talk += ev.text;
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
    if (talk.trim()) {
      const already = this.memory.log.filter((m) => m.kind === "talk").at(-1)?.text === talk;
      if (!already) {
        const seat = seatOf(this.harness.id);
        const msg = this.memory.append({ kind: "talk", text: talk, seat, hops: tools.includes("zoom") ? tools.join(" → ") : undefined });
        this.emit({ type: "message", session: "main", message: msg });
      }
      await this.openLinks(talk);
    }
    void this.memory.pump();
    this.emitDebug();
  }

  private fallbackFrom(err: string): boolean {
    if (!isQuotaError(err)) return false;
    if (this.harness.id !== "claude") return false;
    const backup = this.cfg.backupHarness;
    if (backup === "claude" || backup === "auto") return false;
    this.switchMain(backup);
    const seat = seatOf(backup);
    const msg = this.memory.append({
      kind: "talk",
      text: `Claude bateu no limite (quota/rate-limit). Passei o harness principal para ${backup} e reintento o turno. Mesma memória, mesmas tools, mesmas skills.`,
      seat,
    });
    this.emit({ type: "message", session: "main", message: msg });
    return true;
  }

  async callMcp(name: string, args: Record<string, unknown>, from: string): Promise<string> {
    const mem = this.forks.get(from)?.memory ?? this.memory;
    switch (name) {
      case "zoom": {
        const r = mem.zoom(Number(args.id), Number(args.n));
        return r.ok ? r.lines.join("\n") : r.error;
      }
      case "date":
        return mem.dateOf(Number(args.id));
      case "recall":
        return mem.recall(String(args.pattern ?? "")).join("\n") || "No match.";
      case "ncli.render": {
        const kind = String(args.kind ?? "html");
        const source = String(args.source ?? "");
        return renderToolToFence(kind, source);
      }
      case "open_fork": {
        const view = String(args.view ?? "");
        const params = paramsOf(args.params);
        const qs = new URLSearchParams(params).toString();
        const opened = await this.openLinks(`view://${view}${qs ? `?${qs}` : ""}`);
        return opened.map((f) => `${f.id} ${f.status}`).join("\n") || "not opened";
      }
      case "close_fork":
        await this.ackFork(String(args.id ?? ""), args.summary ? String(args.summary) : undefined);
        return "ok";
      case "list_views":
        return JSON.stringify(this.views.list().map((v) => ({ id: v.id, label: v.label })));
      case "list_forks":
        return JSON.stringify(this.forks.list().map((f) => ({ id: f.id, view: f.view, status: f.status })));
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
    switch (ev.type) {
      case "text":
        this.emit({ type: "delta", session: "main", seat: ev.seat ?? "claude", text: ev.text });
        break;
      case "tool": {
        tools.push(ev.name);
        const msg = this.memory.append({
          kind: "tool",
          text: formatTool(ev.name, ev.input),
          tool: { name: ev.name, input: ev.input },
        });
        this.emit({ type: "message", session: "main", message: msg });
        this.emit({ type: "tool", session: "main", name: ev.name, input: ev.input });
        break;
      }
      case "tool_result": {
        const msg = this.memory.append({ kind: "echo", text: ev.content });
        this.emit({ type: "message", session: "main", message: msg });
        break;
      }
      case "seat":
        if (ev.status === "done" && ev.text) {
          const msg = this.memory.append({ kind: "seat", text: ev.text, seat: ev.seat });
          this.emit({ type: "message", session: "main", message: msg });
        } else {
          this.emit({ type: "delta", session: "main", seat: ev.seat, text: ev.text ?? ev.status });
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

  close(): void {
    for (const rt of this.forks.runtimes.values()) rt.abort.abort();
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

function pickCompressor(cfg: NcliConfig): Compressor {
  switch (cfg.compactBackend) {
    case "mock":
      return mockCompressor();
    case "claude":
      return haikuCompressor(cfg);
    case "cursor":
      return cursorCompressor(cfg);
    case "auto":
      return cfg.harness === "mock" ? mockCompressor() : cursorCompressor(cfg);
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

function formatTool(name: string, input: unknown): string {
  if (name === "zoom" && input && typeof input === "object") {
    const o = input as { id?: number; n?: number };
    return `zoom(${o.id}+${o.n})`;
  }
  if (name === "date" && input && typeof input === "object") {
    return `date(#${(input as { id?: number }).id})`;
  }
  if (name === "ncli.render" && input && typeof input === "object") {
    return `ncli.render(${(input as { kind?: string }).kind ?? "?"})`;
  }
  if (name === "ask" && input && typeof input === "object") {
    const o = input as { agent?: string };
    return `ask(${o.agent ?? "?"})`;
  }
  return `${name}`;
}

function seatOf(id: string): SeatId {
  if (id === "codex" || id === "cursor" || id === "claude") return id;
  return "claude";
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
