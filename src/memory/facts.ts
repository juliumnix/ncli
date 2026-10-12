import type { Message } from "../types";

export type Successor = { by: number; reason: string };

export function factsOf(log: readonly Message[]): Map<number, Successor> {
  const index = new Map<number, Successor>();
  for (const msg of log) {
    if (!msg) continue;
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

export function wouldCycle(index: Map<number, Successor>, olds: readonly number[], neu: number): boolean {
  const blocked = new Set(olds);
  const seen = new Set<number>();
  let cur: number | undefined = neu;
  while (cur !== undefined && !seen.has(cur)) {
    if (blocked.has(cur)) return true;
    seen.add(cur);
    cur = index.get(cur)?.by;
  }
  return false;
}

export function supersededHeader(index: Map<number, Successor>, id: number): string | undefined {
  const hit = index.get(id);
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
