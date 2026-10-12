import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CompactDeferred } from "../src/memory/cursor-compact";
import { Memory, mockCompressor } from "../src/memory/store";
import { tmpDir } from "./helpers";

test("view.json reloads the saved parts", async () => {
  const dir = tmpDir("v2-view");
  const mem = new Memory({
    dir,
    nodeBytes: 400,
    viewBytes: 40,
    compressor: mockCompressor(),
  });
  for (let i = 0; i < 8; i++) mem.append({ kind: "user", text: `msg-${i}-abcdefghij` });
  await mem.settle();
  const saved = mem.view.map((part) => ({ start: part.start, n: part.n }));
  const again = new Memory({
    dir,
    nodeBytes: 400,
    viewBytes: 40,
    compressor: mockCompressor(),
  });
  expect(again.view.map((part) => ({ start: part.start, n: part.n }))).toEqual(saved);
  writeFileSync(join(dir, "view.json"), JSON.stringify(Array.from({ length: mem.T }, (_, i) => [0, i])));
  const planted = new Memory({
    dir,
    nodeBytes: 400,
    viewBytes: 40,
    compressor: mockCompressor(),
  });
  expect(planted.view.map((part) => part.n)).toEqual(Array(mem.T).fill(1));
  expect(saved.some((part) => part.n > 1)).toBe(true);
});

test("forget drops the node and its ancestor without editing the log", async () => {
  const dir = tmpDir("v2-forget");
  const mem = new Memory({
    dir,
    nodeBytes: 200,
    viewBytes: 8000,
    compressor: mockCompressor(),
  });
  for (let i = 0; i < 4; i++) mem.append({ kind: "user", text: `m${i}` });
  await mem.settleQuiescent();
  expect(mem.nodeOf(0, 0)?.text).toContain("m0");
  expect(mem.nodeOf(1, 0)?.text).toContain("m0");
  const logBefore = readFileSync(join(dir, "log.jsonl"), "utf8");
  mem.forget(0, 0);
  expect(mem.nodeOf(0, 0)).toBeUndefined();
  expect(mem.nodeOf(1, 0)).toBeUndefined();
  expect(readFileSync(join(dir, "log.jsonl"), "utf8")).toBe(logBefore);
  expect(readFileSync(join(dir, "tree.jsonl"), "utf8")).toContain('"dropped":true');
  const again = new Memory({
    dir,
    nodeBytes: 200,
    viewBytes: 8000,
    compressor: mockCompressor(),
  });
  expect(again.nodeOf(0, 0)).toBeUndefined();
  expect(again.nodeOf(1, 0)).toBeUndefined();
});

test("fsync append still writes the log line", () => {
  const dir = tmpDir("v2-fsync");
  const mem = new Memory({
    dir,
    nodeBytes: 200,
    viewBytes: 2000,
    compressor: mockCompressor(),
  });
  mem.append({ kind: "user", text: "hello fsync" });
  expect(readFileSync(join(dir, "log.jsonl"), "utf8")).toContain("hello fsync");
});

test("a deferred compact leaves the node unbuilt", async () => {
  const mem = new Memory({
    dir: tmpDir("v2-defer"),
    nodeBytes: 20,
    viewBytes: 4000,
    compressor: async () => {
      throw new CompactDeferred();
    },
  });
  mem.append({ kind: "user", text: "x".repeat(80) });
  await mem.pump();
  expect(mem.nodeOf(0, 0)).toBeUndefined();
  expect(mem.view[0]?.built).toBe(false);
  expect(mem.viewLines()[0]).toContain("(not summarized yet: zoom it)");
  expect(mem.pendingCount()).toBeGreaterThan(0);
});
