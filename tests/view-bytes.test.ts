import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { factsOf, supersededHeader } from "../src/memory/facts";
import { Memory, mockCompressor } from "../src/memory/store";
import { pairDue } from "../src/memory/merge-order";
import { utf8Bytes } from "../src/util";
import { tmpDir } from "./helpers";

function fullBytes(mem: Memory): number {
  const facts = factsOf(mem.log);
  return mem.view.reduce((s, p) => {
    const header = p.n === 1 ? supersededHeader(facts, p.start) : undefined;
    return s + p.size + (header ? utf8Bytes(`${header}\n`) : 0);
  }, 0);
}

function mergeable(mem: Memory): boolean {
  for (let k = 0; k < mem.view.length - 1; k++) {
    const a = mem.view[k]!;
    const b = mem.view[k + 1]!;
    if (a.l === b.l && a.i % 2 === 0 && b.i === a.i + 1) return true;
  }
  return false;
}

function open(dir: string): Memory {
  return new Memory({ dir, nodeBytes: 120, viewBytes: 1600, compressor: mockCompressor() });
}

function expectFitted(mem: Memory) {
  expect(mem.viewBytesUsed()).toBe(fullBytes(mem));
}

function expectAfterFit(mem: Memory) {
  expectFitted(mem);
  if (mem.viewBytesUsed() > mem.viewLow) expect(mergeable(mem)).toBe(false);
}

test("incremental view bytes match a full recompute after append, fit, placeholders and restart", async () => {
  const dir = tmpDir("view-bytes");
  const mem = open(dir);
  mem.paused = true;
  for (let i = 0; i < 300; i++) {
    if (i % 25 === 24) mem.append({ kind: "note", text: `RATE=${i}`, supersedes: [i - 3, i - 7], reason: `fix ${i}` });
    else mem.append({ kind: i % 2 ? "talk" : "user", text: `linha ${i} ${"x".repeat(i % 40)}` });
    expectFitted(mem);
  }
  expect(mem.view.some((p) => !p.built)).toBe(true);
  mem.fit();
  expectAfterFit(mem);

  mem.paused = false;
  await mem.pump();
  await mem.settle(3_000);
  mem.fit();
  expectAfterFit(mem);
  mem.paused = true;

  const warm = open(dir);
  warm.paused = true;
  expectFitted(warm);
  expect(warm.view.map((p) => `${p.l}:${p.i}`)).toEqual(mem.view.map((p) => `${p.l}:${p.i}`));

  rmSync(join(dir, "view.json"));
  const cold = open(dir);
  cold.paused = true;
  expectFitted(cold);
  cold.append({ kind: "note", text: "RATE=final", supersedes: [0], reason: "after restart" });
  expectFitted(cold);
}, 60_000);

test("cold boot does not recount the whole view per message", () => {
  const n = 8000;
  const dir = tmpDir("view-linear");
  const seed = open(dir);
  seed.paused = true;
  seed.ingest(Array.from({ length: n }, (_, i) => ({ kind: "user" as const, text: `linha ${i} ${"y".repeat(i % 60)}` })), { quiet: true });
  rmSync(join(dir, "view.json"), { force: true });
  const proto = Memory.prototype as unknown as { viewBytesUsed: () => number };
  const real = proto.viewBytesUsed;
  let calls = 0;
  proto.viewBytesUsed = function (this: Memory) {
    calls += 1;
    return real.call(this);
  };
  try {
    const mem = open(dir);
    mem.paused = true;
    expect(mem.log.length).toBe(n);
    expect(calls).toBeLessThan(n / 10);
  } finally {
    proto.viewBytesUsed = real;
  }
  const mem = open(dir);
  mem.paused = true;
  expectFitted(mem);
}, 120_000);

type Part = Memory["view"][number];

/** The pre-heap fit(): linear scan per merge. Kept as the oracle for merge order. */
function legacyFit(mem: Memory, view: Part[], low: number): string[] {
  const m = mem as unknown as { T: number; partFromLevel(l: number, i: number): Part };
  const facts = factsOf(mem.log);
  const bytesOf = (p: Part) => {
    const header = p.n === 1 ? supersededHeader(facts, p.start) : undefined;
    return p.size + (header ? utf8Bytes(`${header}\n`) : 0);
  };
  const order: string[] = [];
  while (view.reduce((s, p) => s + bytesOf(p), 0) > low) {
    let bestAt = -1;
    let bestDue = Number.NEGATIVE_INFINITY;
    let bestBuilt = false;
    for (let k = 0; k < view.length - 1; k++) {
      const a = view[k]!;
      const b = view[k + 1]!;
      if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
      const built = Boolean(mem.nodeOf(a.l + 1, Math.floor(a.i / 2)));
      const due = pairDue(m.T, a.l, a.i);
      if (built !== bestBuilt) {
        if (built || bestAt < 0) {
          bestBuilt = built;
          bestDue = due;
          bestAt = k;
        }
        continue;
      }
      if (due > bestDue) {
        bestDue = due;
        bestAt = k;
      }
    }
    if (bestAt < 0) break;
    const a = view[bestAt]!;
    order.push(`${a.l + 1}:${Math.floor(a.i / 2)}`);
    view.splice(bestAt, 2, m.partFromLevel(a.l + 1, Math.floor(a.i / 2)));
  }
  return order;
}

test("heap fit merges in the same order as the legacy linear scan", async () => {
  const dir = tmpDir("view-heap-order");
  const mem = open(dir);
  for (let i = 0; i < 160; i++) mem.append({ kind: i % 2 ? "talk" : "user", text: `a ${i} ${"z".repeat(i % 50)}` });
  await mem.pump();
  await mem.settle(3_000);
  mem.paused = true;
  for (let i = 0; i < 400; i++) {
    if (i % 31 === 30) mem.append({ kind: "note", text: `B=${i}`, supersedes: [i], reason: "r" });
    else mem.append({ kind: "user", text: `b ${i} ${"w".repeat(i % 70)}` });
  }
  const internals = mem as unknown as { view: Part[]; muteChange: boolean; rebuildView(): void };
  internals.muteChange = true;
  for (const low of [1200, 600, 200, 0]) {
    internals.rebuildView();
    (mem as unknown as { refreshViewParts(): void }).refreshViewParts();
    const before = internals.view.slice();
    const merges: string[] = [];
    const prev = new Set(before.map((p) => `${p.l}:${p.i}`));
    const mutable = mem as unknown as { viewLow: number };
    const realLow = mutable.viewLow;
    Object.defineProperty(mem, "viewLow", { value: low, configurable: true, writable: true });
    const expected = legacyFit(mem, before.slice(), low);
    const expectedView = (() => {
      const v = before.slice();
      legacyFit(mem, v, low);
      return v.map((p) => `${p.l}:${p.i}:${p.built}`);
    })();
    const realNotify = (mem as unknown as { notify(): void }).notify;
    (mem as unknown as { notify(): void }).notify = function () {
      for (const p of internals.view) {
        const key = `${p.l}:${p.i}`;
        if (prev.has(key)) continue;
        merges.push(key);
        prev.add(key);
      }
    };
    mem.fit();
    (mem as unknown as { notify(): void }).notify = realNotify;
    Object.defineProperty(mem, "viewLow", { value: realLow, configurable: true, writable: true });
    if (low === 0) expect(expected.length).toBeGreaterThan(20);
    expect(merges).toEqual(expected);
    expect(internals.view.map((p) => `${p.l}:${p.i}:${p.built}`)).toEqual(expectedView);
    expect(mem.viewBytesUsed()).toBe(fullBytes(mem));
  }
}, 120_000);
