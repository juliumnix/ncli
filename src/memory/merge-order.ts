export interface PushEntry {
  tick: number;
  keep: 0 | 1;
}

interface PushNode {
  keep: 0 | 1;
  life: number;
  state: number;
  older: PushNode | null;
}

export interface CoverSpan {
  start: number;
  n: number;
}

export function pairDue(T: number, l: number, i: number): number {
  const span = 2 ** l;
  const last = (i + 2) * span - 1;
  return (T - last) / span;
}

function pushNode(newState: number, states: PushNode | null): PushNode {
  if (states === null) return { keep: 0, life: 0, state: newState, older: null };
  const { keep, life, state, older } = states;
  if (keep === 0) return { keep: 1, life, state, older };
  if (life > 0) {
    return { keep: 0, life: 0, state: newState, older: { keep: 0, life: life - 1, state, older } };
  }
  return { keep: 0, life, state: newState, older: pushNode(state, older) };
}

let built = 0;
let head: PushNode | null = null;

function resetPush(): void {
  built = 0;
  head = null;
}

function ensure(T: number): void {
  if (T < built) resetPush();
  while (built < T) {
    head = pushNode(built, head);
    built += 1;
  }
}

export function pushStates(T: number): PushEntry[] {
  if (T <= 0) return [];
  ensure(T);
  const entries: PushEntry[] = [];
  for (let node = head; node; node = node.older) entries.push({ tick: node.state, keep: node.keep });
  return entries;
}

export function pushView(T: number): CoverSpan[] {
  if (T <= 0) return [];
  const ticks = pushStates(T).map((entry) => entry.tick).reverse();
  return ticks.map((start, idx) => ({
    start,
    n: (ticks[idx + 1] ?? T) - start,
  }));
}

export type DueFn = (T: number, l: number, i: number) => number;

interface CoverPart {
  l: number;
  i: number;
  start: number;
  n: number;
}

export function incrementalView(maxT: number, due: DueFn, targetAt: (T: number) => number): CoverSpan[][] {
  const history: CoverSpan[][] = [];
  let view: CoverPart[] = [];
  for (let T = 1; T <= maxT; T++) {
    view.push({ l: 0, i: T - 1, start: T - 1, n: 1 });
    const target = targetAt(T);
    while (view.length > target) {
      let bestAt = -1;
      let bestDue = Number.NEGATIVE_INFINITY;
      for (let k = 0; k < view.length - 1; k++) {
        const a = view[k];
        const b = view[k + 1];
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
        const score = due(T, a.l, a.i);
        if (score > bestDue) {
          bestDue = score;
          bestAt = k;
        }
      }
      if (bestAt < 0) break;
      const a = view[bestAt];
      view.splice(bestAt, 2, {
        l: a.l + 1,
        i: Math.floor(a.i / 2),
        start: a.start,
        n: a.n * 2,
      });
    }
    history.push(view.map((p) => ({ start: p.start, n: p.n })));
  }
  return history;
}
