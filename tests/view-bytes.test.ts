import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { factsOf, supersededHeader } from "../src/memory/facts";
import { Memory, mockCompressor } from "../src/memory/store";
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
