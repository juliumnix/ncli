import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CompactJob = {
  l: number;
  i: number;
  last: number;
  hash: string;
};

export const COMPACT_QUEUE_FILE = "compact-queue.json";

export function parseCompactJob(raw: unknown): CompactJob | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { l?: unknown; i?: unknown; last?: unknown; due?: unknown; hash?: unknown };
  if (typeof rec.l !== "number" || typeof rec.i !== "number") return null;
  const last = typeof rec.last === "number" ? rec.last : typeof rec.due === "number" ? rec.due : null;
  if (last === null || typeof rec.hash !== "string" || !rec.hash) return null;
  return { l: rec.l, i: rec.i, last, hash: rec.hash };
}

export function sortByLast(jobs: CompactJob[]): CompactJob[] {
  return [...jobs].sort((a, b) => {
    if (b.last !== a.last) return b.last - a.last;
    if (a.l !== b.l) return a.l - b.l;
    return a.i - b.i;
  });
}

export function jobKey(job: Pick<CompactJob, "l" | "i">): string {
  return `${job.l}:${job.i}`;
}

export function upsertJob(jobs: CompactJob[], job: CompactJob): CompactJob[] {
  const key = jobKey(job);
  const next = jobs.filter((j) => jobKey(j) !== key);
  next.push(job);
  return sortByLast(next);
}

export function dropJob(jobs: CompactJob[], job: Pick<CompactJob, "l" | "i">): CompactJob[] {
  const key = jobKey(job);
  return jobs.filter((j) => jobKey(j) !== key);
}

export function loadCompactQueue(dir: string): CompactJob[] | null {
  const path = join(dir, COMPACT_QUEUE_FILE);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { jobs?: unknown };
    if (!data || !Array.isArray(data.jobs)) return [];
    const jobs: CompactJob[] = [];
    const seen = new Set<string>();
    for (const raw of data.jobs) {
      const job = parseCompactJob(raw);
      if (!job) continue;
      const key = jobKey(job);
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
    }
    return sortByLast(jobs);
  } catch {
    return [];
  }
}

export function saveCompactQueue(dir: string, jobs: CompactJob[]): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, COMPACT_QUEUE_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ jobs: sortByLast(jobs) })}\n`);
  renameSync(tmp, path);
}

export class CompactQueue {
  private jobs: CompactJob[] = [];
  private loaded = false;

  constructor(private readonly dir: string) {}

  load(): CompactJob[] | null {
    const saved = loadCompactQueue(this.dir);
    this.loaded = true;
    if (!saved) {
      this.jobs = [];
      return null;
    }
    this.jobs = saved;
    return saved;
  }

  list(): CompactJob[] {
    if (!this.loaded) this.load();
    return [...this.jobs];
  }

  put(job: CompactJob): void {
    if (!this.loaded) this.load();
    this.jobs = upsertJob(this.jobs, job);
    saveCompactQueue(this.dir, this.jobs);
  }

  remove(slot: Pick<CompactJob, "l" | "i">): void {
    if (!this.loaded) this.load();
    const before = this.jobs.length;
    this.jobs = dropJob(this.jobs, slot);
    if (this.jobs.length !== before) saveCompactQueue(this.dir, this.jobs);
  }

  replace(jobs: CompactJob[]): void {
    this.loaded = true;
    this.jobs = sortByLast(jobs);
    saveCompactQueue(this.dir, this.jobs);
  }
}
