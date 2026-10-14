import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../types";
import { applyFact, FACTS_FILE, parseFactsDump, type Successor } from "./facts";

export const MSG_PAGE = 100;
export const MSG_PAGE_MAX = 200;
export const INDEX_FILE = "log.offsets.bin";
export const DAYS_FILE = "log.days.json";
export const LOG_FILE = "log.jsonl";

const MAGIC = 0x4e494458;
const HEADER = 12;

export type MessageSlice = {
  messages: Message[];
  before: number | null;
  after: number | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  messageCount: number;
};

export type SearchHit = {
  i: number;
  date: string;
  kind: string;
  snippet: string;
};

export type DayTick = { i: number; day: string };

export type SliceOpts = {
  before?: number;
  after?: number;
  around?: number;
  limit?: number;
};

export function msgLimit(limit?: number): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return MSG_PAGE;
  return Math.min(MSG_PAGE_MAX, Math.floor(n));
}

export class LogIndex {
  readonly dir: string;
  readonly facts = new Map<number, Successor>();
  private offsets: number[] = [];
  private days: DayTick[] = [];
  private bytes = 0;
  private factsAt = 0;
  private map: Uint8Array | null = null;
  private mapBytes = 0;

  constructor(dir: string) {
    this.dir = dir;
    this.load();
  }

  get count(): number {
    return this.offsets.length;
  }

  get size(): number {
    return this.bytes;
  }

  get logPath(): string {
    return join(this.dir, LOG_FILE);
  }

  reset(): void {
    this.offsets = [];
    this.days = [];
    this.bytes = 0;
    this.facts.clear();
    this.factsAt = 0;
    this.map = null;
    this.mapBytes = 0;
  }

  push(offset: number, date: string, byteLen: number): void {
    const i = this.offsets.length;
    this.offsets.push(offset);
    this.bytes = offset + byteLen;
    const day = dayOf(date);
    const last = this.days.at(-1);
    if (!last || last.day !== day) this.days.push({ i, day });
  }

  persist(): void {
    const buf = Buffer.alloc(HEADER + this.offsets.length * 4);
    buf.writeUInt32LE(MAGIC, 0);
    buf.writeUInt32LE(this.offsets.length, 4);
    buf.writeUInt32LE(this.bytes, 8);
    for (let i = 0; i < this.offsets.length; i++) buf.writeUInt32LE(this.offsets[i] ?? 0, HEADER + i * 4);
    const bin = join(this.dir, INDEX_FILE);
    writeFileSync(`${bin}.tmp`, buf);
    renameSync(`${bin}.tmp`, bin);
    writeFileSync(join(this.dir, DAYS_FILE), JSON.stringify(this.days));
    this.persistFacts();
  }

  noteFact(msg: Message): void {
    applyFact(this.facts, msg);
    if (typeof msg.i === "number") this.factsAt = Math.max(this.factsAt, msg.i + 1);
    if (msg.supersedes?.length) this.persistFacts();
  }

  readAtSync(id: number): Message | undefined {
    const line = this.lineAtSync(id);
    if (!line) return undefined;
    try {
      return JSON.parse(line) as Message;
    } catch {
      return undefined;
    }
  }

  lineAtSync(id: number): string {
    if (id < 0 || id >= this.offsets.length) return "";
    const map = this.mapped();
    if (!map) return "";
    const from = this.offsets[id] ?? 0;
    const to = id + 1 < this.offsets.length ? this.offsets[id + 1] ?? this.bytes : this.bytes;
    const end = Math.min(Math.max(from, to), map.byteLength);
    const start = Math.min(from, end);
    let line = Buffer.from(map.subarray(start, end)).toString("utf8");
    if (line.endsWith("\n")) line = line.slice(0, -1);
    return line;
  }

  rawText(): string {
    const map = this.mapped();
    if (!map) return "";
    return new TextDecoder().decode(map);
  }

  rebuildSync(): void {
    this.reset();
    if (!existsSync(this.logPath)) {
      this.persist();
      return;
    }
    const buf = readFileSync(this.logPath);
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 10) continue;
      if (i > start) {
        const line = buf.toString("utf8", start, i);
        if (line.trim()) this.recordLine(start, line);
      }
      start = i + 1;
    }
    if (start < buf.length) {
      const line = buf.toString("utf8", start, buf.length);
      if (line.trim()) this.recordLine(start, line);
    }
    this.persist();
  }

  async rebuild(): Promise<void> {
    this.rebuildSync();
  }

  async page(opts: SliceOpts = {}): Promise<MessageSlice> {
    const limit = msgLimit(opts.limit);
    const n = this.count;
    let start = 0;
    let end = n;
    if (opts.around != null && Number.isFinite(opts.around)) {
      const mid = Math.max(0, Math.min(n, Math.floor(opts.around)));
      start = Math.max(0, mid - Math.floor(limit / 2));
      end = Math.min(n, start + limit);
      start = Math.max(0, end - limit);
    } else if (opts.after != null && Number.isFinite(opts.after)) {
      start = Math.max(0, Math.min(n, Math.floor(opts.after)));
      end = Math.min(n, start + limit);
    } else {
      end = opts.before == null || !Number.isFinite(opts.before)
        ? n
        : Math.max(0, Math.min(n, Math.floor(opts.before)));
      start = Math.max(0, end - limit);
    }
    const messages = await this.readRange(start, end);
    return {
      messages,
      before: start > 0 ? start : null,
      after: end < n ? end : null,
      hasMoreBefore: start > 0,
      hasMoreAfter: end < n,
      messageCount: n,
    };
  }

  async search(q: string, limit = 20): Promise<SearchHit[]> {
    const needle = q.trim().toLowerCase();
    if (!needle || !existsSync(this.logPath)) return [];
    const file = Bun.file(this.logPath);
    const size = file.size;
    const chunk = 1 << 20;
    const hits: SearchHit[] = [];
    let pos = 0;
    let carry = "";
    let i = 0;
    while (pos < size && hits.length < limit) {
      const end = Math.min(size, pos + chunk);
      const text = carry + await file.slice(pos, end).text();
      carry = "";
      let from = 0;
      for (let c = 0; c < text.length; c++) {
        if (text.charCodeAt(c) !== 10) continue;
        const line = text.slice(from, c);
        from = c + 1;
        const hit = matchLine(line, i, needle);
        i += 1;
        if (hit) {
          hits.push(hit);
          if (hits.length >= limit) return hits;
        }
      }
      if (from < text.length) carry = text.slice(from);
      pos = end;
    }
    if (carry.trim() && hits.length < limit) {
      const hit = matchLine(carry, i, needle);
      if (hit) hits.push(hit);
    }
    return hits;
  }

  ticks(): DayTick[] {
    return this.days;
  }

  firstOnOrAfter(day: string): number {
    const want = dayOf(day);
    for (const tick of this.days) {
      if (tick.day >= want) return tick.i;
    }
    return 0;
  }

  stale(): boolean {
    if (!existsSync(this.logPath)) return this.count > 0;
    const st = statSync(this.logPath);
    return this.bytes !== st.size;
  }

  private recordLine(offset: number, line: string): void {
    let date = "";
    try {
      const msg = JSON.parse(line) as Message;
      date = String(msg.date ?? "");
      this.push(offset, date, Buffer.byteLength(`${line}\n`));
      applyFact(this.facts, msg);
      this.factsAt = this.count;
      return;
    } catch {
      date = "";
    }
    this.push(offset, date, Buffer.byteLength(`${line}\n`));
    this.factsAt = this.count;
  }

  private persistFacts(): void {
    const path = join(this.dir, FACTS_FILE);
    writeFileSync(`${path}.tmp`, JSON.stringify({ at: this.factsAt, entries: [...this.facts] }));
    renameSync(`${path}.tmp`, path);
  }

  private loadFacts(): void {
    const path = join(this.dir, FACTS_FILE);
    if (!existsSync(path)) return;
    const dump = parseFactsDump(readFileSync(path, "utf8"));
    if (!dump) return;
    this.facts.clear();
    for (const [id, hit] of dump.entries) {
      if (typeof id !== "number" || !hit || typeof hit.by !== "number") continue;
      this.facts.set(id, { by: hit.by, reason: String(hit.reason ?? "") });
    }
    this.factsAt = dump.at;
  }

  fillFacts(): void {
    if (this.factsAt >= this.count) return;
    for (let i = this.factsAt; i < this.count; i++) {
      const msg = this.readAtSync(i);
      if (msg) applyFact(this.facts, msg);
    }
    this.factsAt = this.count;
    this.persistFacts();
  }

  private mapped(): Uint8Array | null {
    if (!existsSync(this.logPath)) return null;
    const size = statSync(this.logPath).size;
    if (this.map && this.mapBytes >= size) return this.map;
    this.map = Bun.mmap(this.logPath);
    this.mapBytes = this.map.byteLength;
    return this.map;
  }

  private async readRange(start: number, end: number): Promise<Message[]> {
    if (end <= start || !existsSync(this.logPath)) return [];
    const from = this.offsets[start] ?? 0;
    const to = end < this.offsets.length ? this.offsets[end] ?? this.bytes : this.bytes;
    const text = await Bun.file(this.logPath).slice(from, to).text();
    const out: Message[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Message);
      } catch {
        continue;
      }
    }
    return out;
  }

  private load(): void {
    const bin = join(this.dir, INDEX_FILE);
    if (!existsSync(bin)) return;
    const buf = readFileSync(bin);
    if (buf.length < 8 || buf.readUInt32LE(0) !== MAGIC) return;
    const n = buf.readUInt32LE(4);
    const withBytes = HEADER + n * 4;
    const without = 8 + n * 4;
    if (buf.length >= withBytes) {
      this.bytes = buf.readUInt32LE(8);
      this.offsets = new Array(n);
      for (let i = 0; i < n; i++) this.offsets[i] = buf.readUInt32LE(HEADER + i * 4);
    } else if (buf.length >= without) {
      this.bytes = 0;
      this.offsets = new Array(n);
      for (let i = 0; i < n; i++) this.offsets[i] = buf.readUInt32LE(8 + i * 4);
    } else {
      return;
    }
    const daysPath = join(this.dir, DAYS_FILE);
    if (existsSync(daysPath)) {
      try {
        const raw = JSON.parse(readFileSync(daysPath, "utf8")) as DayTick[];
        this.days = Array.isArray(raw) ? raw.filter((t) => t && typeof t.i === "number") : [];
      } catch {
        this.days = [];
      }
    }
    this.loadFacts();
  }
}

function dayOf(iso: string): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function matchLine(line: string, i: number, needle: string): SearchHit | null {
  if (!line.toLowerCase().includes(needle)) return null;
  try {
    const msg = JSON.parse(line) as Message;
    const text = String(msg.text ?? "");
    const at = text.toLowerCase().indexOf(needle);
    const from = Math.max(0, at - 24);
    return {
      i: typeof msg.i === "number" ? msg.i : i,
      date: msg.date ?? "",
      kind: msg.kind ?? "",
      snippet: text.slice(from, from + 80),
    };
  } catch {
    return null;
  }
}
