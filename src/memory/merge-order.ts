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
const stateCache = new Map<number, PushEntry[]>();
const viewCache = new Map<number, CoverSpan[]>();

function ensure(T: number): void {
  while (built < T) {
    head = pushNode(built, head);
    built += 1;
    const entries: PushEntry[] = [];
    for (let node = head; node; node = node.older) entries.push({ tick: node.state, keep: node.keep });
    stateCache.set(built, entries);
    const ticks = entries.map((entry) => entry.tick).reverse();
    viewCache.set(built, ticks.map((start, idx) => ({
      start,
      n: (ticks[idx + 1] ?? built) - start,
    })));
  }
}

export function pushStates(T: number): PushEntry[] {
  if (T <= 0) return [];
  ensure(T);
  return stateCache.get(T) ?? [];
}

export function pushView(T: number): CoverSpan[] {
  if (T <= 0) return [];
  ensure(T);
  return viewCache.get(T) ?? [];
}

type DueFn = (T: number, l: number, i: number) => number;

function popcount(n: number): number {
  let count = 0;
  let x = n;
  while (x) {
    count += x & 1;
    x >>>= 1;
  }
  return count;
}

function maxPairIndex(T: number, l: number): number {
  const span = 2 ** l;
  const slots = Math.floor(T / span);
  if (slots < 2) return -1;
  return (slots - (slots & 1)) - 2;
}

function rangeOf(l: number, i: number): [number, number] {
  const span = 2 ** l;
  return [i * span, (i + 2) * span];
}

function contains(outer: [number, number], inner: [number, number]): boolean {
  return outer[0] <= inner[0] && outer[1] >= inner[1] && (outer[0] !== inner[0] || outer[1] !== inner[1]);
}

function findEqual(T: number, due: DueFn, l: number, target: number, iMax: number): number {
  let lo = 0;
  let hi = iMax >> 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const i = mid * 2;
    const score = due(T, l, i);
    if (score === target) return i;
    if (score > target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function countBetter(T: number, due: DueFn, lP: number, iP: number): number {
  const target = due(T, lP, iP);
  const startP = iP * 2 ** lP;
  const rangeP = rangeOf(lP, iP);
  let count = 0;
  for (let l = 0; 2 ** (l + 1) <= T; l++) {
    const iMax = maxPairIndex(T, l);
    if (iMax < 0) break;
    let lo = 0;
    let hi = iMax >> 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const i = mid * 2;
      if (due(T, l, i) > target) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    count += best + 1;
    const eq = findEqual(T, due, l, target, iMax);
    if (eq < 0 || (l === lP && eq === iP)) continue;
    const rangeQ = rangeOf(l, eq);
    // Equal due does not make an ancestor available: its descendant still has to merge first.
    if (contains(rangeP, rangeQ)) count += 1;
    else if (contains(rangeQ, rangeP)) continue;
    else if (eq * 2 ** l < startP) count += 1;
  }
  return count;
}

function pairMerged(T: number, due: DueFn, merges: number, l: number, i: number): boolean {
  return countBetter(T, due, l, i) < merges;
}

export function greedyView(T: number, due: DueFn, budget: number): CoverSpan[] {
  if (T <= 0) return [];
  const minParts = popcount(T);
  const finalParts = Math.max(minParts, Math.min(T, Math.max(0, budget)));
  const merges = T - finalParts;
  if (merges === 0) {
    const leaves: CoverSpan[] = [];
    for (let i = 0; i < T; i++) leaves.push({ start: i, n: 1 });
    return leaves;
  }
  const out: CoverSpan[] = [];
  let pos = 0;
  while (pos < T) {
    let maxL = 0;
    while (pos % 2 ** (maxL + 1) === 0 && pos + 2 ** (maxL + 1) <= T) maxL += 1;
    let chosen = 0;
    for (let l = maxL; l >= 0; l--) {
      const n = 2 ** l;
      const complete = l === 0 || pairMerged(T, due, merges, l - 1, pos / 2 ** (l - 1));
      if (!complete) continue;
      const idx = pos / n;
      let up = false;
      if (idx % 2 === 0) {
        if (pos + 2 * n <= T) up = pairMerged(T, due, merges, l, idx);
      } else up = pairMerged(T, due, merges, l, idx - 1);
      if (!up) {
        chosen = l;
        break;
      }
    }
    const n = 2 ** chosen;
    out.push({ start: pos, n });
    pos += n;
  }
  return out;
}
