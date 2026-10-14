import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyFact, factsOf, supersededHeader } from "../src/memory/facts";
import { LogIndex } from "../src/memory/log-index";
import { Memory, mockCompressor } from "../src/memory/store";
import { utf8Bytes } from "../src/util";
import { makeHub, tmpDir } from "./helpers";

function memAt(dir: string): Memory {
  return new Memory({ dir, nodeBytes: 200, viewBytes: 800, compressor: mockCompressor() });
}

function writeLog(dir: string, n: number, extra = "") {
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: n }, (_, i) => {
    if (i === 10) {
      return JSON.stringify({
        i,
        kind: "note",
        text: "supersedes #2 → #3: planted",
        size: 20,
        date: "2024-01-11T00:00:00.000Z",
        supersedes: [2],
        successor: 3,
        reason: "planted",
      });
    }
    return JSON.stringify({
      i,
      kind: i % 2 === 0 ? "user" : "talk",
      text: extra && i === 0 ? `${extra} primeira` : `linha ${i} **md**`,
      size: 20,
      date: `2024-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  });
  writeFileSync(join(dir, "log.jsonl"), `${lines.join("\n")}\n`);
}

function fullBytes(mem: Memory): number {
  const facts = new Map(mem.factsCached());
  const oracle = new Map<number, { by: number; reason: string }>();
  for (let i = 0; i < mem.T; i++) {
    const m = mem.at(i);
    if (m) applyFact(oracle, m);
  }
  expect([...facts.entries()].sort((a, b) => a[0] - b[0])).toEqual(
    [...oracle.entries()].sort((a, b) => a[0] - b[0]),
  );
  return mem.view.reduce((s, p) => {
    const header = p.n === 1 ? supersededHeader(oracle, p.start) : undefined;
    return s + p.size + (header ? utf8Bytes(`${header}\n`) : 0);
  }, 0);
}

test("after restart, zoom and recall reach msg 0 without a full log", () => {
  const dir = tmpDir("partial-zoom");
  const n = 2500;
  writeLog(dir, n, "MARKER_ZERO");
  new LogIndex(dir).rebuildSync();
  const mem = memAt(dir);
  mem.paused = true;
  expect(mem.log.length).toBe(0);
  expect(mem.T).toBe(n);
  const zoom = mem.zoom(0, 1);
  expect(zoom.ok).toBe(true);
  if (!zoom.ok) return;
  expect(zoom.lines.join("\n")).toContain("MARKER_ZERO");
  expect(mem.recall("MARKER_ZERO").join("\n")).toContain("#0");
  expect(mem.dateOf(0)).toBe("2024-01-01T00:00:00.000Z");
});

test("after restart, supersede of an old fact and the #62 counter match a full walk", async () => {
  const dir = tmpDir("partial-super");
  writeLog(dir, 2500, "MARKER_ZERO");
  new LogIndex(dir).rebuildSync();
  const mem = memAt(dir);
  mem.paused = true;
  expect(mem.log.length).toBe(0);
  const planted = mem.zoom(2, 1);
  expect(planted.ok).toBe(true);
  if (!planted.ok) return;
  expect(planted.lines[0]).toBe("SUPERSEDED by #3 (planted)");
  expect(planted.lines[1]).toContain("linha 2");

  const dataDir = tmpDir("partial-hub");
  const first = await makeHub({ dataDir });
  const memDir = first.hub.memory.dir;
  first.hub.close();
  writeLog(memDir, 2500, "OLD_FACT");
  new LogIndex(memDir).rebuildSync();
  const again = await makeHub({ dataDir });
  try {
    again.hub.memory.paused = true;
    expect(again.hub.memory.log.length).toBe(0);
    expect(again.hub.memory.T).toBe(2500);
    const out = await again.hub.callMcp(
      "supersede",
      { old: 20, new: 21, reason: "old fact" },
      "main",
    );
    expect(out).toMatch(/^ok #/);
    const zoom = again.hub.memory.zoom(20, 1);
    expect(zoom.ok).toBe(true);
    if (!zoom.ok) return;
    expect(zoom.lines[0]).toBe("SUPERSEDED by #21 (old fact)");
    expect(again.hub.memory.viewBytesUsed()).toBe(fullBytes(again.hub.memory));
  } finally {
    again.hub.close();
  }

  mem.append({
    kind: "note",
    text: "supersedes #20 → #21: old fact",
    supersedes: [20],
    successor: 21,
    reason: "old fact",
  });
  const late = mem.zoom(20, 1);
  expect(late.ok).toBe(true);
  if (!late.ok) return;
  expect(late.lines[0]).toBe("SUPERSEDED by #21 (old fact)");
  expect(mem.viewBytesUsed()).toBe(fullBytes(mem));
  expect(factsOf(mem.log).size).toBeLessThan(mem.factsCached().size);
});

test("zoom and recall of msg 0 stay cheap on a 100k skip-parse log", () => {
  const dir = tmpDir("partial-100k");
  const n = 100_000;
  writeLog(dir, n, "MARKER_ZERO");
  new LogIndex(dir).rebuildSync();
  const mem = memAt(dir);
  mem.paused = true;
  expect(mem.log.length).toBe(0);
  expect(mem.T).toBe(n);
  const t0 = performance.now();
  const zoom = mem.zoom(0, 1);
  const zoomMs = performance.now() - t0;
  expect(zoom.ok).toBe(true);
  if (!zoom.ok) return;
  expect(zoom.lines.join("\n")).toContain("MARKER_ZERO");
  const t1 = performance.now();
  const recalled = mem.recall("MARKER_ZERO");
  const recallMs = performance.now() - t1;
  expect(recalled.join("\n")).toContain("#0");
  expect(zoomMs).toBeLessThan(20);
  expect(recallMs).toBeLessThan(200);
});

test("incremental view bytes match a full recompute after append and restart", () => {
  const dir = tmpDir("view-bytes-partial");
  const mem = memAt(dir);
  mem.paused = true;
  for (let i = 0; i < 80; i++) {
    if (i % 20 === 19) {
      mem.append({ kind: "note", text: `RATE=${i}`, supersedes: [i - 3], reason: `fix ${i}` });
    } else {
      mem.append({ kind: i % 2 ? "talk" : "user", text: `linha ${i}` });
    }
    expect(mem.viewBytesUsed()).toBe(fullBytes(mem));
  }
  const warm = memAt(dir);
  warm.paused = true;
  expect(warm.viewBytesUsed()).toBe(fullBytes(warm));
});
