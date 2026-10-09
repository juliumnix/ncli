import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Message, MsgKind, SeatId, TreeNode, ViewPart } from "../types";
import { flattenLine, isPowerOfTwo, nowIso, utf8Bytes } from "../util";

export interface MemoryOptions {
  dir: string;
  nodeBytes: number;
  viewBytes: number;
  compressor: Compressor;
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

export class Memory {
  readonly dir: string;
  readonly nodeBytes: number;
  readonly viewBytes: number;
  readonly compressor: Compressor;
  readonly log: Message[] = [];
  readonly nodes = new Map<string, TreeNode>();
  view: ViewPart[] = [];
  private busy = new Set<string>();
  private waiters: Array<() => void> = [];
  private pumping: Promise<void> | null = null;

  constructor(opts: MemoryOptions) {
    this.dir = opts.dir;
    this.nodeBytes = opts.nodeBytes;
    this.viewBytes = opts.viewBytes;
    this.compressor = opts.compressor;
    mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  get T(): number {
    return this.log.length;
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
    forkId?: string;
    tool?: Message["tool"];
    hops?: string;
    date?: string;
    stepId?: string;
    parentId?: string;
    durationMs?: number;
  }): Message {
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
      forkId: partial.forkId,
      tool: partial.tool,
      hops: partial.hops,
      stepId: partial.stepId,
      parentId: partial.parentId,
      durationMs: partial.durationMs,
    };
    this.log.push(msg);
    persistLine(join(this.dir, "log.jsonl"), msg);
    this.view.push(this.partFromLevel(0, msg.i));
    this.fit();
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

  settle(timeoutMs = 30_000): Promise<boolean> {
    if (this.allBuilt()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== on);
        resolve(this.allBuilt());
      }, timeoutMs);
      const on = () => {
        if (!this.allBuilt()) return;
        clearTimeout(t);
        this.waiters = this.waiters.filter((w) => w !== on);
        resolve(true);
      };
      this.waiters.push(on);
    });
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
      return { ok: true, lines: [`${id}+0|${m.kind}: ${m.text}`] };
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
      budget: this.viewBytes,
      levels: this.levels(),
      T: this.T,
    };
  }

  pendingCount(): number {
    let n = 0;
    const T = this.T;
    for (let l = 0; 2 ** l <= T; l++) {
      const size = 2 ** l;
      for (let i = 0; (i + 1) * size <= T; i++) {
        if (!this.nodeOf(l, i) && !this.busy.has(Memory.key(l, i))) n++;
      }
    }
    return n;
  }

  async pump(): Promise<void> {
    if (this.pumping) {
      return this.pumping.then(() => {
        if (this.nextBuildable()) return this.pump();
      });
    }
    this.pumping = this.pumpLoop().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async pumpLoop(): Promise<void> {
    for (;;) {
      const next = this.nextBuildable();
      if (!next) break;
      const key = Memory.key(next.l, next.i);
      this.busy.add(key);
      try {
        await this.build(next.l, next.i);
      } finally {
        this.busy.delete(key);
      }
      this.fit();
    }
    this.flushWaiters();
  }

  private nextBuildable(): { l: number; i: number } | null {
    const T = this.T;
    const firstUnbuilt = this.firstUnbuiltStart();
    for (let l = 0; 2 ** l <= T; l++) {
      for (let i = 0; (i + 1) * (2 ** l) <= T; i++) {
        const key = Memory.key(l, i);
        if (this.nodeOf(l, i) || this.busy.has(key)) continue;
        if (!this.ready(l, i)) continue;
        const end = l === 0 ? i : (i + 1) * 2 ** l;
        if (end > firstUnbuilt) continue;
        return { l, i };
      }
    }
    return null;
  }

  private firstUnbuiltStart(): number {
    for (const p of this.view) {
      if (!p.built) return p.start;
    }
    return this.T;
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
        : await this.compressor({
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
      : await this.compressor({
          kind: "merge",
          contextLines: this.contextBefore((i + 1) * 2 ** l),
          source: joined,
          left: left.text,
          right: right.text,
          nodeBytes,
        });
    this.putNode(l, i, text);
  }

  private putNode(l: number, i: number, text: string): void {
    const node: TreeNode = { l, i, text: flattenLine(text), size: utf8Bytes(flattenLine(text)) };
    this.nodes.set(Memory.key(l, i), node);
    persistLine(join(this.dir, "tree.jsonl"), node);
    this.refreshViewParts();
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
    const placeholder = `${i * n}+1|(not summarized yet: zoom it)`;
    const text = node?.text ?? placeholder;
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
      if (!node) return p;
      return { ...p, text: node.text, size: node.size, built: true };
    });
  }

  private renderPart(p: ViewPart): string {
    return `${p.start}+${p.n}|${flattenLine(p.text)}`;
  }

  fit(): void {
    this.refreshViewParts();
    const T = this.T;
    let size = this.viewBytesUsed();
    while (size > this.viewBytes) {
      let bestAt = -1;
      let bestDue = -1;
      for (let k = 0; k < this.view.length - 1; k++) {
        const a = this.view[k];
        const b = this.view[k + 1];
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
        const parent = this.nodeOf(a.l + 1, Math.floor(a.i / 2));
        if (!parent) continue;
        const start = a.i * 2 ** a.l;
        const due = (T - start) / 2 ** (a.l + 2);
        if (due > bestDue) {
          bestDue = due;
          bestAt = k;
        }
      }
      if (bestAt < 0) break;
      const a = this.view[bestAt];
      const parentPart = this.partFromLevel(a.l + 1, Math.floor(a.i / 2));
      this.view.splice(bestAt, 2, parentPart);
      size = this.viewBytesUsed();
    }
    this.flushWaiters();
  }

  rebuildView(): void {
    this.view = [];
    for (let i = 0; i < this.T; i++) {
      this.view.push(this.partFromLevel(0, i));
      this.fit();
    }
  }

  private flushWaiters(): void {
    if (!this.allBuilt()) return;
    const ws = this.waiters.splice(0);
    for (const w of ws) w();
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
          const n = JSON.parse(line) as TreeNode;
          this.nodes.set(Memory.key(n.l, n.i), n);
        } catch {
          continue;
        }
      }
    }
    this.rebuildView();
  }
}

function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const keep = Math.floor(cap / 2) - 20;
  return `${text.slice(0, keep)}\n…[${text.length - keep * 2} chars cut]…\n${text.slice(-keep)}`;
}

function persistLine(path: string, obj: unknown): void {
  appendFileSync(path, `${JSON.stringify(obj)}\n`, "utf8");
}

export function mockCompressor(): Compressor {
  return async (input) => {
    const limit = input.nodeBytes;
    const raw = input.kind === "merge"
      ? `${input.left ?? ""} ${input.right ?? ""}`
      : input.source;
    const keywords = raw.match(KEYWORD) ?? [];
    const uniq = [...new Set(keywords)];
    const base = flattenLine(raw);
    let line = base;
    if (utf8Bytes(line) > limit) line = base.slice(0, Math.max(40, limit - 40));
    if (uniq.length) {
      const extra = uniq.join(" ");
      const room = limit - utf8Bytes(line) - 1;
      if (room > 8) line = `${line} ${extra}`.slice(0, line.length + room);
      else line = `${cutKeep(line, limit - utf8Bytes(extra) - 1)} ${extra}`;
    }
    if (utf8Bytes(line) > limit) line = cutKeep(line, limit);
    return line || "…";
  };
}

function cutKeep(s: string, n: number): string {
  if (utf8Bytes(s) <= n) return s;
  let out = s;
  while (utf8Bytes(out) > n && out.length) out = out.slice(0, -1);
  return out;
}

export function writeSnapshot(mem: Memory): void {
  writeFileSync(join(mem.dir, "view.txt"), mem.renderView(), "utf8");
}
