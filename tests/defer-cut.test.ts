import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CompactDeferred } from "../src/memory/compact-deferred";
import { Memory } from "../src/memory/store";
import { tmpDir } from "./helpers";

const OVER = "x".repeat(281);

test("a 281-byte line is cut locally after N deferrals instead of staying pending", async () => {
  let calls = 0;
  const mem = new Memory({
    dir: tmpDir("defer-cut"),
    nodeBytes: 280,
    viewBytes: 4000,
    deferCutAfter: 2,
    deferBackoffMs: 15,
    compressor: async () => {
      calls += 1;
      throw new CompactDeferred();
    },
  });
  mem.append({ kind: "user", text: OVER });
  await mem.pump();
  expect(mem.nodeOf(0, 0)).toBeUndefined();
  await Bun.sleep(80);
  await mem.pump();
  const node = mem.nodeOf(0, 0);
  expect(node).toBeDefined();
  expect(node!.text.startsWith("user:")).toBe(true);
  expect(node!.size).toBeLessThanOrEqual(280);
  expect(calls).toBeGreaterThan(0);
  expect(calls).toBeLessThan(6);
});

test("deferred nodes back off instead of retrying on every append", async () => {
  let calls = 0;
  const mem = new Memory({
    dir: tmpDir("defer-backoff"),
    nodeBytes: 40,
    viewBytes: 4000,
    deferCutAfter: 8,
    deferBackoffMs: 5_000,
    compressor: async () => {
      calls += 1;
      throw new CompactDeferred();
    },
  });
  mem.append({ kind: "user", text: `first ${"q".repeat(80)}` });
  await mem.pump();
  const afterFirst = calls;
  expect(afterFirst).toBe(1);
  mem.append({ kind: "note", text: "short" });
  await mem.pump();
  expect(calls).toBe(afterFirst);
});

test("saveView replaces view.json atomically and leaves no tmp", async () => {
  const dir = tmpDir("atomic-view");
  const mem = new Memory({
    dir,
    nodeBytes: 80,
    viewBytes: 400,
    compressor: async (input) => input.source.slice(0, 40),
  });
  mem.append({ kind: "user", text: "alpha" });
  await mem.pump();
  expect(existsSync(join(dir, "view.json"))).toBe(true);
  expect(existsSync(join(dir, "view.json.tmp"))).toBe(false);
  JSON.parse(readFileSync(join(dir, "view.json"), "utf8"));
});
