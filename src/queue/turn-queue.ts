import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "../util";

export type QueueMode = "steer" | "queue";

export interface QueueItem {
  id: string;
  session: string;
  text: string;
  mode: QueueMode;
  createdAt: string;
}

export class TurnQueue {
  private items: QueueItem[] = [];
  private n = 0;
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "queue.json");
    this.load();
  }

  list(session?: string): QueueItem[] {
    if (!session) return [...this.items];
    return this.items.filter((i) => i.session === session);
  }

  enqueue(partial: { session: string; text: string; mode: QueueMode }): QueueItem {
    const item: QueueItem = {
      id: `q${++this.n}`,
      session: partial.session,
      text: partial.text,
      mode: partial.mode,
      createdAt: nowIso(),
    };
    this.items.push(item);
    this.save();
    return item;
  }

  remove(id: string): boolean {
    const next = this.items.filter((i) => i.id !== id);
    if (next.length === this.items.length) return false;
    this.items = next;
    this.save();
    return true;
  }

  takeNext(session: string): QueueItem | undefined {
    const mine = this.items.filter((i) => i.session === session);
    const item = mine.find((i) => i.mode === "steer") ?? mine[0];
    if (!item) return undefined;
    this.remove(item.id);
    return item;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { n?: number; items?: QueueItem[] };
      this.items = Array.isArray(raw.items) ? raw.items : [];
      this.n = typeof raw.n === "number" ? raw.n : this.items.length;
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify({ n: this.n, items: this.items }, null, 2), "utf8");
  }
}
