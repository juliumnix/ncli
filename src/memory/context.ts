import type { CompactStatus, ContextOp, ContextRow, ContextSnapshot } from "../types";
import type { Memory } from "./store";

const TONE_STOPS: Array<[number, [number, number, number]]> = [
  [0, [40, 167, 69]],
  [2, [92, 184, 92]],
  [5, [156, 184, 44]],
  [8, [208, 128, 48]],
  [10, [178, 102, 32]],
];

export function contextRows(mem: Memory): ContextRow[] {
  return mem.view.map((p) => {
    const first = mem.log[p.start];
    const last = mem.log[Math.min(p.start + p.n - 1, mem.T - 1)] ?? first;
    return {
      id: `${p.start}+${p.n}`,
      start: p.start,
      n: p.n,
      text: p.text,
      built: p.built,
      from: first?.date ?? "",
      to: last?.date ?? first?.date ?? "",
      kind: p.n === 1 ? first?.kind : undefined,
      seat: p.n === 1 ? first?.seat : undefined,
    };
  });
}

export function contextSnapshot(mem: Memory, compact: CompactStatus): ContextSnapshot {
  return {
    type: "context",
    session: "main",
    rows: contextRows(mem),
    bytes: mem.viewBytesUsed(),
    budget: mem.viewBytes,
    pending: mem.pendingCount(),
    T: mem.T,
    compact,
  };
}

export function partsCover(rows: ContextRow[], T: number): boolean {
  let i = 0;
  for (const row of rows) {
    if (row.start !== i) return false;
    if (row.n < 1) return false;
    i += row.n;
  }
  return i === T;
}

export function diffContext(prev: ContextRow[], next: ContextRow[]): ContextOp[] {
  const prevById = new Map(prev.map((row) => [row.id, row]));
  const ops: ContextOp[] = [];
  for (const row of next) {
    const old = prevById.get(row.id);
    if (old) {
      if (old.text !== row.text || old.built !== row.built) ops.push({ op: "update", id: row.id });
      continue;
    }
    const half = row.n / 2;
    if (half >= 1 && Number.isInteger(half)) {
      const left = `${row.start}+${half}`;
      const right = `${row.start + half}+${half}`;
      if (prevById.has(left) && prevById.has(right)) {
        ops.push({ op: "merge", from: [left, right], into: row.id });
        continue;
      }
    }
    ops.push({ op: "add", id: row.id });
  }
  return ops;
}

export function badgeTone(n: number): string {
  const lv = Math.log2(Math.max(1, n));
  let lo = TONE_STOPS[0];
  let hi = TONE_STOPS[TONE_STOPS.length - 1];
  for (let i = 0; i < TONE_STOPS.length - 1; i++) {
    if (lv >= TONE_STOPS[i][0] && lv <= TONE_STOPS[i + 1][0]) {
      lo = TONE_STOPS[i];
      hi = TONE_STOPS[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const t = Math.min(1, Math.max(0, (lv - lo[0]) / span));
  const rgb = lo[1].map((c, i) => Math.round(c + (hi[1][i] - c) * t));
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return "agora";
  if (s < 60) return `há ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d < 45) return `há ${d} d`;
  const mo = Math.round(d / 30);
  if (mo < 18) return `~${mo} ${mo === 1 ? "mês" : "meses"} atrás`;
  const y = Math.round(d / 365);
  return `~${y} ${y === 1 ? "ano" : "anos"} atrás`;
}
