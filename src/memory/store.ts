import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Message, MsgKind, SeatId, TreeNode, ViewPart } from "../types";
import { flattenLine, isPowerOfTwo, keepRecent, nowIso, utf8Bytes } from "../util";
import { CompactDeferred } from "./compact-deferred";
import { factsOf, supersededHeader } from "./facts";
import { pairDue } from "./merge-order";

export interface MemoryOptions {
  dir: string;
  nodeBytes: number;
  viewBytes: number;
  compressor: Compressor;
  pumpBatch?: number;
  deferCutAfter?: number;
  deferBackoffMs?: number;
  compressTimeoutMs?: number;
}

export type Compressor = (input: CompactInput) => Promise<string>;

export interface CompactInput {
  kind: "leaf" | "merge";
  contextLines: string[];
  source: string;
  left?: string;
  right?: string;
  nodeBytes: number;
}

export type ZoomResult =
  | { ok: true; lines: string[] }
  | { ok: false; error: string };

const KEYWORD = /[A-Z][A-Z0-9_]{7,}/g;
const PENDING_TEXT = "(not summarized yet: zoom it)";

const MEMORY_KINDS = new Set<MsgKind>(["user", "talk", "note", "seat", "merge", "bus"]);

interface Slot {
  l: number;
  i: number;
}

interface DeferRec {
  fails: number;
  until: number;
}

export class Memory {
  readonly dir: string;
  readonly nodeBytes: number;
  readonly viewBytes: number;
  readonly compressor: Compressor;
  readonly pumpBatch: number;
  readonly deferCutAfter: number;
  readonly deferBackoffMs: number;
  readonly compressTimeoutMs: number;
  readonly log: Message[] = [];
  readonly nodes = new Map<string, TreeNode>();
  view: ViewPart[] = [];
  onChange: (() => void) | null = null;
  private busy = new Set<string>();
  private readyQ: Slot[] = [];
  private queued = new Set<string>();
  private deferred = new Map<string, DeferRec>();
  private waiters = new Set<() => void>();
  private pumping: Promise<void> | null = null;
  private muteChange = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: MemoryOptions) {
    this.dir = opts.dir;
    this.nodeBytes = opts.nodeBytes;
    this.viewBytes = opts.viewBytes;
    this.compressor = opts.compressor;
    this.pumpBatch = opts.pumpBatch ?? 6;
    this.deferCutAfter = opts.deferCutAfter ?? 3;
    this.deferBackoffMs = opts.deferBackoffMs ?? 2000;
    this.compressTimeoutMs = opts.compressTimeoutMs ?? 30_000;
    mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  get T(): number {
    return this.log.length;
  }

  get viewLow(): number {
    return this.viewBytes;
  }

  get viewHigh(): number {
    return this.viewBytes * 2;
  }

  static key(l: number, i: number): string {
    return `${l}:${i}`;
  }

  nodeOf(l: number, i: number): TreeNode | undefined {
    return this.nodes.get(Memory.key(l, i));
  }

  append(partial: {
    kind: MsgKind;
    text: string;
    seat?: SeatId;
    model?: string;
    to?: string;
    sparkId?: string;
    tool?: Message["tool"];
    hops?: string;
    date?: string;
    stepId?: string;
    parentId?: string;
    durationMs?: number;
    supersedes?: number[];
    successor?: number;
    reason?: string;
  }): Message {
    if (!MEMORY_KINDS.has(partial.kind)) {
      throw new Error(`memory does not store ${partial.kind} steps`);
    }
    const text = capText(partial.text, 80_000);
    const msg: Message = {
      i: this.log.length,
      kind: partial.kind,
      text,
      size: utf8Bytes(`${partial.kind}: ${text}`),
      date: partial.date ?? nowIso(),
      seat: partial.seat,
      model: partial.model,
      to: partial.to,
      sparkId: partial.sparkId,
      tool: partial.tool,
      hops: partial.hops,
      stepId: partial.stepId,
      parentId: partial.parentId,
      durationMs: partial.durationMs,
      supersedes: partial.supersedes,
      successor: partial.successor,
      reason: partial.reason,
    };
    this.log.push(msg);
    persistLine(join(this.dir, "log.jsonl"), msg);
    this.view.push(this.partFromLevel(0, msg.i));
    this.enqueue(0, msg.i);
    if (this.viewBytesUsed() > this.viewHigh) this.fit();
    else this.saveView();
    this.notify();
    void this.pump();
    return msg;
  }

  renderView(): string {
    const lines = this.view.map((p) => this.renderPart(p));
    return `<chat>\n${lines.join("\n")}\n</chat>`;
  }

  viewLines(): string[] {
    return this.view.map((p) => this.renderPart(p));
  }

  levels(): string[] {
    const counts = new Map<number, number>();
    for (const p of this.view) counts.set(p.n, (counts.get(p.n) ?? 0) + 1);
    return [...counts.keys()].sort((a, b) => b - a).map((n) => `${n}×`);
  }

  viewBytesUsed(): number {
    return this.view.reduce((s, p) => s + p.size, 0);
  }

  allBuilt(): boolean {
    return this.view.every((p) => p.built);
  }

  /** Resolves when every visible cover part is built. Off-cover parents may still be pending. */
  settle(timeoutMs = 30_000): Promise<boolean> {
    return this.waitUntil(() => this.allBuilt(), timeoutMs);
  }

  deferredCount(): number {
    return this.deferred.size;
  }

  isQuiescent(): boolean {
    return this.deferred.size === 0 && !this.hasInFlight();
  }

  settleQuiescent(timeoutMs = 30_000): Promise<boolean> {
    void this.pump();
    return this.waitUntil(() => this.isQuiescent() && this.allBuilt(), timeoutMs);
  }

  hasInFlight(): boolean {
    if (this.busy.size > 0) return true;
    return this.readyQ.some((slot) => {
      const key = Memory.key(slot.l, slot.i);
      return !this.heldOff(key) && !this.nodes.has(key) && !this.busy.has(key) && this.ready(slot.l, slot.i);
    });
  }

  waitForInFlight(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? 400;
    const signal = opts.signal;
    if (signal?.aborted) return Promise.resolve(false);
    if (!this.hasInFlight()) return Promise.resolve(this.allBuilt());
    return this.waitUntil(() => !this.hasInFlight(), timeoutMs, signal).then(() => this.allBuilt());
  }

  private waitUntil(ready: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        this.waiters.delete(on);
        signal?.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const t = setTimeout(() => finish(ready()), timeoutMs);
      const onAbort = () => finish(false);
      const on = () => {
        if (ready()) finish(true);
      };
      this.waiters.add(on);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted || ready()) finish(ready() && !signal?.aborted);
    });
  }

  forget(l: number, i: number): void {
    let cl = l;
    let ci = i;
    for (;;) {
      const key = Memory.key(cl, ci);
      const had = this.nodes.delete(key);
      persistLine(join(this.dir, "tree.jsonl"), { l: cl, i: ci, dropped: true });
      this.enqueue(cl, ci);
      const parentL = cl + 1;
      const parentI = Math.floor(ci / 2);
      if (!had || !this.nodes.has(Memory.key(parentL, parentI))) break;
      cl = parentL;
      ci = parentI;
    }
    this.refreshViewParts();
    this.saveView();
    this.notify();
    void this.pump();
  }

  zoom(id: number, n: number): ZoomResult {
    if (!isPowerOfTwo(n) || id < 0 || id % n !== 0) {
      return { ok: false, error: `No line ${id}+${n}.` };
    }
    if (id + n > this.T) {
      return { ok: false, error: `No line ${id}+${n}.` };
    }
    if (n === 1) {
      const m = this.log[id];
      if (!m) return { ok: false, error: `No line ${id}+${n}.` };
      const header = supersededHeader(factsOf(this.log), id);
      const line = `${id}+0|${m.kind}: ${m.text}`;
      return { ok: true, lines: header ? [header, line] : [line] };
    }
    const l = Math.log2(n);
    const i = id / n;
    const childL = l - 1;
    const left = this.nodeOf(childL, 2 * i);
    const right = this.nodeOf(childL, 2 * i + 1);
    const lines: string[] = [];
    const n2 = n / 2;
    lines.push(`${id}+${n2}|${left?.text ?? "not compressed yet"}`);
    if (id + n2 < this.T) {
      lines.push(`${id + n2}+${n2}|${right?.text ?? "not compressed yet"}`);
    }
    return { ok: true, lines };
  }

  dateOf(id: number): string {
    const m = this.log[id];
    if (!m) return `No message ${id}.`;
    return m.date;
  }

  recall(re: string): string[] {
    let pat: RegExp;
    try {
      pat = new RegExp(re, "i");
    } catch {
      return [`bad regex: ${re}`];
    }
    return this.log
      .filter((m) => pat.test(`#${m.i} ${m.kind} ${m.text}`))
      .slice(-40)
      .map((m) => `#${m.i} ${m.kind}: ${m.text}`);
  }

  debug(): { lines: string[]; bytes: number; budget: number; levels: string[]; T: number } {
    return {
      lines: this.viewLines(),
      bytes: this.viewBytesUsed(),
      budget: this.viewHigh,
      levels: this.levels(),
      T: this.T,
    };
  }

  pendingCount(): number {
    const seen = new Set<string>();
    let n = 0;
    for (const slot of this.readyQ) {
      const key = Memory.key(slot.l, slot.i);
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.nodes.has(key) || this.busy.has(key) || !this.ready(slot.l, slot.i)) continue;
      n += 1;
    }
    return n + this.busy.size;
  }

  async pump(): Promise<void> {
    if (this.pumping) {
      return this.pumping.then(() => {
        if (this.hasInFlight()) return this.pump();
      });
    }
    this.pumping = this.pumpLoop().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async pumpLoop(): Promise<void> {
    for (;;) {
      const batch = this.nextBuildableBatch(this.pumpBatch);
      if (!batch.length) break;
      await Promise.all(
        batch.map(async (next) => {
          const key = Memory.key(next.l, next.i);
          this.busy.add(key);
          let defer = false;
          try {
            await this.build(next.l, next.i);
          } catch (err) {
            if (!(err instanceof CompactDeferred)) throw err;
            defer = true;
          } finally {
            this.busy.delete(key);
          }
          if (defer) this.onDeferred(next.l, next.i);
        }),
      );
      if (this.viewBytesUsed() > this.viewHigh) this.fit();
    }
    this.notifyWaiters();
    this.scheduleRetry();
  }

  private onDeferred(l: number, i: number): void {
    const key = Memory.key(l, i);
    const prev = this.deferred.get(key);
    const fails = (prev?.fails ?? 0) + 1;
    if (fails >= this.deferCutAfter) {
      this.deferred.delete(key);
      this.putNode(l, i, this.cutSource(l, i));
      return;
    }
    const wait = Math.min(30_000, this.deferBackoffMs * 2 ** (fails - 1));
    this.deferred.set(key, { fails, until: Date.now() + wait });
    this.enqueue(l, i);
  }

  private cutSource(l: number, i: number): string {
    if (l === 0) {
      const m = this.log[i];
      return keepRecent(flattenLine(`${m.kind}: ${m.text}`), this.nodeBytes);
    }
    const left = this.nodeOf(l - 1, 2 * i)?.text ?? "";
    const right = this.nodeOf(l - 1, 2 * i + 1)?.text ?? "";
    return keepRecent(flattenLine(`${left} ${right}`), this.nodeBytes);
  }

  private heldOff(key: string): boolean {
    const rec = this.deferred.get(key);
    return Boolean(rec && rec.until > Date.now());
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.hasInFlight()) return;
    let next = Number.POSITIVE_INFINITY;
    for (const rec of this.deferred.values()) {
      if (rec.until < next) next = rec.until;
    }
    if (!Number.isFinite(next)) return;
    const wait = Math.max(1, next - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.pump();
    }, wait);
    this.retryTimer.unref?.();
  }

  private nextBuildableBatch(max: number): Slot[] {
    const out: Slot[] = [];
    const hold: Slot[] = [];
    while (out.length < max && this.readyQ.length) {
      const slot = this.readyQ.shift();
      if (!slot) break;
      const key = Memory.key(slot.l, slot.i);
      this.queued.delete(key);
      if (this.heldOff(key)) {
        hold.push(slot);
        continue;
      }
      if (this.nodes.has(key) || this.busy.has(key) || !this.ready(slot.l, slot.i)) continue;
      out.push(slot);
    }
    for (const slot of hold) this.enqueue(slot.l, slot.i);
    return out;
  }

  private enqueue(l: number, i: number): void {
    const key = Memory.key(l, i);
    if (this.queued.has(key) || this.busy.has(key) || this.nodes.has(key)) return;
    if (!this.ready(l, i)) return;
    this.queued.add(key);
    this.readyQ.push({ l, i });
  }

  private ready(l: number, i: number): boolean {
    if (l === 0) return i < this.T;
    return Boolean(this.nodeOf(l - 1, 2 * i) && this.nodeOf(l - 1, 2 * i + 1));
  }

  private async build(l: number, i: number): Promise<void> {
    const nodeBytes = this.nodeBytes;
    if (l === 0) {
      const m = this.log[i];
      const source = `${m.kind}: ${m.text}`;
      const text = utf8Bytes(source) <= nodeBytes
        ? source
        : await this.runCompressor({
            kind: "leaf",
            contextLines: this.contextBefore(i),
            source,
            nodeBytes,
          });
      this.putNode(l, i, text);
      return;
    }
    const left = this.nodeOf(l - 1, 2 * i)!;
    const right = this.nodeOf(l - 1, 2 * i + 1)!;
    const joined = `${left.text}\n${right.text}`;
    const text = utf8Bytes(joined) <= nodeBytes
      ? flattenLine(joined)
      : await this.runCompressor({
          kind: "merge",
          contextLines: this.contextBefore((i + 1) * 2 ** l),
          source: joined,
          left: left.text,
          right: right.text,
          nodeBytes,
        });
    this.putNode(l, i, text);
  }

  private async runCompressor(input: CompactInput): Promise<string> {
    const work = this.compressor(input);
    const ms = this.compressTimeoutMs;
    if (ms <= 0) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CompactDeferred()), ms);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      void work.then(
        () => undefined,
        () => undefined,
      );
    }
  }

  private putNode(l: number, i: number, text: string): void {
    const flat = flattenLine(text);
    const node: TreeNode = { l, i, text: flat, size: utf8Bytes(flat) };
    this.nodes.set(Memory.key(l, i), node);
    persistLine(join(this.dir, "tree.jsonl"), node);
    this.deferred.delete(Memory.key(l, i));
    this.refreshViewParts();
    this.enqueue(l + 1, Math.floor(i / 2));
    this.saveView();
    this.notify();
  }

  private contextBefore(end: number): string[] {
    const lines: string[] = [];
    for (const p of this.view) {
      if (p.start + p.n > end) break;
      if (p.built) lines.push(p.text);
    }
    return lines;
  }

  private partFromLevel(l: number, i: number): ViewPart {
    const n = 2 ** l;
    const node = this.nodeOf(l, i);
    const text = node?.text ?? PENDING_TEXT;
    return {
      l,
      i,
      start: i * n,
      n,
      text,
      size: utf8Bytes(text),
      built: Boolean(node),
    };
  }

  private refreshViewParts(): void {
    this.view = this.view.map((p) => {
      const node = this.nodeOf(p.l, p.i);
      if (!node) return { ...p, text: PENDING_TEXT, size: utf8Bytes(PENDING_TEXT), built: false };
      return { ...p, text: node.text, size: node.size, built: true };
    });
  }

  private renderPart(p: ViewPart): string {
    return `${p.start}+${p.n}|${flattenLine(p.text)}`;
  }

  fit(): void {
    this.refreshViewParts();
    while (this.viewBytesUsed() > this.viewLow) {
      let bestAt = -1;
      let bestDue = Number.NEGATIVE_INFINITY;
      let bestBuilt = false;
      for (let k = 0; k < this.view.length - 1; k++) {
        const a = this.view[k];
        const b = this.view[k + 1];
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
        const built = Boolean(this.nodeOf(a.l + 1, Math.floor(a.i / 2)));
        const due = pairDue(this.T, a.l, a.i);
        if (built !== bestBuilt) {
          if (built || bestAt < 0) {
            bestBuilt = built;
            bestDue = due;
            bestAt = k;
          }
          continue;
        }
        if (due > bestDue) {
          bestDue = due;
          bestAt = k;
        }
      }
      if (bestAt < 0) break;
      const a = this.view[bestAt];
      this.view.splice(bestAt, 2, this.partFromLevel(a.l + 1, Math.floor(a.i / 2)));
      this.notify();
    }
    this.saveView();
    this.notifyWaiters();
  }

  rebuildView(): void {
    this.muteChange = true;
    this.view = [];
    for (let i = 0; i < this.T; i++) {
      this.view.push(this.partFromLevel(0, i));
      if (this.viewBytesUsed() > this.viewHigh) this.fit();
    }
    this.muteChange = false;
    this.saveView();
    this.notify();
  }

  private notify(): void {
    if (this.muteChange) return;
    this.onChange?.();
    this.notifyWaiters();
  }

  private notifyWaiters(): void {
    for (const w of [...this.waiters]) w();
  }

  private load(): void {
    const logPath = join(this.dir, "log.jsonl");
    const treePath = join(this.dir, "tree.jsonl");
    if (existsSync(logPath)) {
      for (const line of readFileSync(logPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.log.push(JSON.parse(line) as Message);
        } catch {
          continue;
        }
      }
    }
    if (existsSync(treePath)) {
      for (const line of readFileSync(treePath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const n = JSON.parse(line) as TreeNode & { dropped?: boolean };
          if (typeof n.l !== "number" || typeof n.i !== "number") continue;
          const key = Memory.key(n.l, n.i);
          if (n.dropped) this.nodes.delete(key);
          else if (typeof n.text === "string") {
            this.nodes.set(key, { l: n.l, i: n.i, text: n.text, size: n.size ?? utf8Bytes(n.text) });
          }
        } catch {
          continue;
        }
      }
    }
    if (!this.loadSavedView()) this.rebuildView();
    this.seedReady();
  }

  private loadSavedView(): boolean {
    const path = join(this.dir, "view.json");
    if (!existsSync(path)) return false;
    try {
      const saved = parseSavedView(readFileSync(path, "utf8"));
      if (!saved) return false;
      const view = saved.map((part) => this.partFromSaved(part));
      if (!this.coverOk(view)) return false;
      this.view = view;
      return true;
    } catch {
      return false;
    }
  }

  private partFromSaved(part: SavedPart): ViewPart {
    const n = part.n ?? 2 ** part.l;
    const start = part.start ?? part.i * n;
    const node = this.nodeOf(part.l, part.i);
    const text = node?.text ?? PENDING_TEXT;
    return {
      l: part.l,
      i: part.i,
      start,
      n,
      text,
      size: utf8Bytes(text),
      built: Boolean(node),
    };
  }

  private coverOk(parts: ViewPart[]): boolean {
    let at = 0;
    for (const part of parts) {
      if (part.start !== at || part.n < 1) return false;
      at += part.n;
    }
    return at === this.T;
  }

  private seedReady(): void {
    for (let i = 0; i < this.T; i++) this.enqueue(0, i);
    for (const node of this.nodes.values()) this.enqueue(node.l + 1, Math.floor(node.i / 2));
  }

  private saveView(): void {
    const path = join(this.dir, "view.json");
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ parts: this.view }));
    renameSync(tmp, path);
  }
}

function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const keep = Math.floor(cap / 2) - 20;
  return `${text.slice(0, keep)}\n…[${text.length - keep * 2} chars cut]…\n${text.slice(-keep)}`;
}

interface SavedPart {
  l: number;
  i: number;
  start?: number;
  n?: number;
}

function parseSavedView(raw: string): SavedPart[] | null {
  const data = JSON.parse(raw) as unknown;
  if (Array.isArray(data)) return data.every(isPair) ? data.map(([l, i]) => ({ l, i })) : null;
  if (!data || typeof data !== "object" || !Array.isArray((data as { parts?: unknown }).parts)) return null;
  const parts: SavedPart[] = [];
  for (const item of (data as { parts: unknown[] }).parts) {
    if (!item || typeof item !== "object") return null;
    const rec = item as { l?: unknown; i?: unknown; start?: unknown; n?: unknown };
    if (typeof rec.l !== "number" || typeof rec.i !== "number") return null;
    parts.push({
      l: rec.l,
      i: rec.i,
      start: typeof rec.start === "number" ? rec.start : undefined,
      n: typeof rec.n === "number" ? rec.n : undefined,
    });
  }
  return parts;
}

function isPair(item: unknown): item is [number, number] {
  return Array.isArray(item) && item.length >= 2 && typeof item[0] === "number" && typeof item[1] === "number";
}

function persistLine(path: string, obj: unknown): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(obj)}\n`, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function mockCompressor(): Compressor {
  return async (input) => {
    const delay = Number(process.env.NCLI_COMPACT_DELAY ?? 0);
    if (Number.isFinite(delay) && delay > 0) await Bun.sleep(delay);
    const limit = input.nodeBytes;
    const raw = input.kind === "merge"
      ? `${input.left ?? ""} ${input.right ?? ""}`
      : input.source;
    const keywords = raw.match(KEYWORD) ?? [];
    const uniq = [...new Set(keywords)];
    const base = flattenLine(raw);
    let line = base;
    if (utf8Bytes(line) > limit) line = keepRecent(base, Math.max(40, limit - 40));
    if (uniq.length) {
      const extra = uniq.join(" ");
      const room = limit - utf8Bytes(line) - 1;
      if (room > 8) line = keepRecent(`${line} ${extra}`, limit);
      else line = keepRecent(`${keepRecent(line, Math.max(0, limit - utf8Bytes(extra) - 1))} ${extra}`, limit);
    }
    if (utf8Bytes(line) > limit) line = keepRecent(line, limit);
    return line || "…";
  };
}

export function writeSnapshot(mem: Memory): void {
  writeFileSync(join(mem.dir, "view.txt"), mem.renderView(), "utf8");
}
