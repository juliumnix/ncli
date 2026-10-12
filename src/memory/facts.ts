import type { Message } from "../types";

export type Successor = { by: number; reason: string };

export function factsOf(log: readonly Message[]): Map<number, Successor> {
  const index = new Map<number, Successor>();
  for (const msg of log) {
    const olds = msg.supersedes;
    if (!olds?.length) continue;
    const by = msg.successor ?? msg.i;
    const reason = msg.reason ?? "";
    for (const id of olds) {
      if (!Number.isInteger(id) || id < 0) continue;
      index.set(id, { by, reason });
    }
  }
  return index;
}

export function successorOf(index: Map<number, Successor>, id: number): Successor | undefined {
  let cur = index.get(id);
  if (!cur) return undefined;
  const seen = new Set<number>([id]);
  while (index.has(cur.by) && !seen.has(cur.by)) {
    seen.add(cur.by);
    const next = index.get(cur.by);
    if (!next) break;
    cur = next;
  }
  return cur;
}

export function supersededHeader(index: Map<number, Successor>, id: number): string | undefined {
  const hit = successorOf(index, id);
  if (!hit) return undefined;
  return `SUPERSEDED by #${hit.by} (${hit.reason})`;
}

export function parseIds(value: unknown): number[] {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return [value];
  if (typeof value === "string") {
    return value.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
  }
  if (Array.isArray(value)) return value.flatMap(parseIds);
  return [];
}
