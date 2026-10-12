import { expect, test } from "bun:test";
import { incrementalView, pairDue, pushStates, pushView, type CoverSpan } from "../src/memory/merge-order";
import { Memory, mockCompressor } from "../src/memory/store";
import { tmpDir } from "./helpers";

function firstDue(T: number, l: number, i: number): number {
  return (T - i * 2 ** l) / 2 ** l;
}

function same(a: CoverSpan[], b: CoverSpan[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((span, idx) => span.start === b[idx]?.start && span.n === b[idx]?.n);
}

function label(entries: Array<{ tick: number; keep: 0 | 1 }>): string {
  return entries.map((entry) => `${entry.keep ? "+" : "-"}${entry.tick}`).join(",");
}

test("push states match the rollback cases", () => {
  expect(label(pushStates(1))).toBe("-0");
  expect(label(pushStates(2))).toBe("+0");
  expect(label(pushStates(3))).toBe("-2,-0");
  expect(label(pushStates(5))).toBe("-4,+0");
  expect(label(pushStates(10))).toBe("+8,+4,-0");
  expect(pushView(10)).toEqual([
    { start: 0, n: 4 },
    { start: 4, n: 4 },
    { start: 8, n: 2 },
  ]);
});

test("at T=10 last-due prefers 8-9 and first-due prefers 0-7", () => {
  expect(pairDue(10, 0, 8)).toBeGreaterThan(pairDue(10, 2, 0));
  expect(firstDue(10, 2, 0)).toBeGreaterThan(firstDue(10, 0, 8));
});

test("incremental last-due matches pushView; first-due matches 481 times through T=20000", () => {
  const targetAt = (T: number) => pushView(T).length;
  const last = incrementalView(20_000, pairDue, targetAt);
  const first = incrementalView(20_000, firstDue, targetAt);
  let lastHits = 0;
  let firstHits = 0;
  for (let T = 1; T <= 20_000; T++) {
    const push = pushView(T);
    if (same(last[T - 1] ?? [], push)) lastHits += 1;
    if (same(first[T - 1] ?? [], push)) firstHits += 1;
  }
  expect(lastHits).toBe(20_000);
  expect(firstHits).toBe(481);
});

test("Memory.fit at T=10 merges 8-9, not 0-7", async () => {
  const mem = new Memory({
    dir: tmpDir("merge-order"),
    nodeBytes: 80,
    viewBytes: 1_000_000,
    compressor: mockCompressor(),
  });
  for (let i = 0; i < 10; i++) mem.append({ kind: "user", text: `m${i}` });
  await mem.settle();
  expect(mem.nodeOf(3, 0)).toBeDefined();
  expect(mem.nodeOf(1, 4)).toBeDefined();
  const left = mem.nodeOf(2, 0)!;
  const right = mem.nodeOf(2, 1)!;
  const leaf8 = mem.nodeOf(0, 8)!;
  const leaf9 = mem.nodeOf(0, 9)!;
  const parent = mem.nodeOf(1, 4)!;
  left.text = "a".repeat(40);
  left.size = 40;
  right.text = "b".repeat(40);
  right.size = 40;
  leaf8.text = "c".repeat(30);
  leaf8.size = 30;
  leaf9.text = "d".repeat(30);
  leaf9.size = 30;
  parent.text = "z";
  parent.size = 1;
  mem.view = [
    { l: 2, i: 0, start: 0, n: 4, text: left.text, size: left.size, built: true },
    { l: 2, i: 1, start: 4, n: 4, text: right.text, size: right.size, built: true },
    { l: 0, i: 8, start: 8, n: 1, text: leaf8.text, size: leaf8.size, built: true },
    { l: 0, i: 9, start: 9, n: 1, text: leaf9.text, size: leaf9.size, built: true },
  ];
  (mem as { viewBytes: number }).viewBytes = 81;
  mem.fit();
  expect(mem.view.map((p) => `${p.start}+${p.n}`)).toEqual(["0+4", "4+4", "8+2"]);
});
