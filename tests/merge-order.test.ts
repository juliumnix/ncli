import { expect, test } from "bun:test";
import { Memory, mockCompressor } from "../src/memory/store";
import { tmpDir } from "./helpers";

type Cover = Array<{ start: number; n: number }>;

type PushNode = {
  keep: number;
  life: number;
  state: number;
  older: PushNode | null;
};

function push(newState: number, states: PushNode | null): PushNode {
  if (states === null) {
    return { keep: 0, life: 0, state: newState, older: null };
  }
  const { keep, life, state, older } = states;
  if (keep === 0) {
    return { keep: 1, life, state, older };
  }
  if (life > 0) {
    return { keep: 0, life: 0, state: newState, older: { keep: 0, life: life - 1, state, older } };
  }
  return { keep: 0, life, state: newState, older: push(state, older) };
}

function pushCover(t: number): Cover {
  let states: PushNode | null = null;
  for (let i = 0; i < t; i++) states = push(i, states);
  const newest: number[] = [];
  for (let n = states; n; n = n.older) newest.push(n.state);
  const starts = newest.slice().reverse();
  return starts.map((start, idx) => ({ start, n: (starts[idx + 1] ?? t) - start }));
}

function dueLast(T: number, start: number, n: number): number {
  const last = start + 2 * n - 1;
  return (T - last) / n;
}

function dueFirst(T: number, start: number, n: number): number {
  return (T - start) / n;
}

function nextMerge(view: Cover, T: number, due: (T: number, start: number, n: number) => number): { start: number; n: number } | null {
  let bestAt = -1;
  let bestDue = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < view.length - 1; k++) {
    const a = view[k];
    const b = view[k + 1];
    if (a.n !== b.n || a.start % (a.n * 2) !== 0 || b.start !== a.start + a.n) continue;
    const d = due(T, a.start, a.n);
    if (d > bestDue) {
      bestDue = d;
      bestAt = k;
    }
  }
  if (bestAt < 0) return null;
  return { start: view[bestAt].start, n: view[bestAt].n * 2 };
}

function coverWith(due: (T: number, start: number, n: number) => number, t: number): Cover {
  const view: Cover = [];
  for (let T = 1; T <= t; T++) {
    view.push({ start: T - 1, n: 1 });
    const budget = pushCover(T).length;
    while (view.length > budget) {
      const pick = nextMerge(view, T, due);
      if (!pick) break;
      const at = view.findIndex((p) => p.start === pick.start && p.n === pick.n / 2);
      if (at < 0) break;
      view.splice(at, 2, { start: pick.start, n: pick.n });
    }
  }
  return view;
}

const T10: Cover = [
  { start: 0, n: 4 },
  { start: 4, n: 4 },
  { start: 8, n: 1 },
  { start: 9, n: 1 },
];

test("at T=10 due(first) merges 0-7 and due(last) merges 8-9", () => {
  expect(nextMerge(T10, 10, dueFirst)).toEqual({ start: 0, n: 8 });
  expect(nextMerge(T10, 10, dueLast)).toEqual({ start: 8, n: 2 });
});

test("due(last) cover matches push for t = 0..20000", () => {
  const view: Cover = [];
  expect(coverWith(dueLast, 0)).toEqual(pushCover(0));
  for (let t = 1; t <= 20_000; t++) {
    view.push({ start: t - 1, n: 1 });
    const want = pushCover(t);
    while (view.length > want.length) {
      const pick = nextMerge(view, t, dueLast);
      if (!pick) break;
      const at = view.findIndex((p) => p.start === pick.start && p.n === pick.n / 2);
      if (at < 0) break;
      view.splice(at, 2, { start: pick.start, n: pick.n });
    }
    expect(view).toEqual(want);
  }
});

test("Memory.fit at T=10 merges 8-9, not 0-7", async () => {
  const mem = new Memory({
    dir: tmpDir("merge-order"),
    nodeBytes: 80,
    viewBytes: 1_000_000,
    compressor: mockCompressor(),
  });
  for (let i = 0; i < 10; i++) {
    mem.append({ kind: "user", text: `m${i}` });
  }
  await mem.pump();
  expect(mem.nodeOf(3, 0)).toBeDefined();
  expect(mem.nodeOf(1, 4)).toBeDefined();
  mem.view = [
    { l: 2, i: 0, start: 0, n: 4, text: mem.nodeOf(2, 0)!.text, size: mem.nodeOf(2, 0)!.size, built: true },
    { l: 2, i: 1, start: 4, n: 4, text: mem.nodeOf(2, 1)!.text, size: mem.nodeOf(2, 1)!.size, built: true },
    { l: 0, i: 8, start: 8, n: 1, text: mem.nodeOf(0, 8)!.text, size: mem.nodeOf(0, 8)!.size, built: true },
    { l: 0, i: 9, start: 9, n: 1, text: mem.nodeOf(0, 9)!.text, size: mem.nodeOf(0, 9)!.size, built: true },
  ];
  const used = mem.view.reduce((s, p) => s + p.size, 0);
  (mem as { viewBytes: number }).viewBytes = Math.max(1, used - 1);
  const first: string[] = [];
  mem.onChange = () => {
    if (!first.length) first.push(...mem.view.map((p) => `${p.start}+${p.n}`));
  };
  mem.fit();
  expect(first).toEqual(["0+4", "4+4", "8+2"]);
});
