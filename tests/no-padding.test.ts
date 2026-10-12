import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { cursorCompressor, parseNumbered } from "../src/memory/cursor-compact";
import { Memory } from "../src/memory/store";
import { tmpDir } from "./helpers";

const LONG = "user decided FACT_MEMBER_DISCOUNT_BEFORE_TAX applies only to member and before tax. ".repeat(4);

function cfg(dir: string, extra: Record<string, unknown> = {}) {
  return loadConfig({
    dataDir: dir,
    compactBackend: "cursor",
    compactBatch: 2,
    compactDebounceMs: 20,
    compactSkipTokens: 1,
    compactBudgetTokens: 250000,
    compactModel: "claude-haiku-5-5",
    nodeBytes: 140,
    ...extra,
  });
}

test("parseNumbered does not pad a short reply with a sibling line", () => {
  expect(parseNumbered("1. only-one", 2)).toEqual(["only-one", ""]);
});

test("parseNumbered indexes by the printed number, not by line position", () => {
  expect(parseNumbered("1. a\n3. c", 3)).toEqual(["a", "", "c"]);
  expect(parseNumbered("3. c\n1. a", 3)).toEqual(["a", "", "c"]);
});

test("a short batch does not give the second job the first job's text", async () => {
  const dir = tmpDir("nopad");
  const compact = cursorCompressor(cfg(dir), async () => "1. only-one");
  const settled = await Promise.allSettled([
    compact({ kind: "leaf", source: `${LONG} one`, contextLines: [], nodeBytes: 140 }),
    compact({ kind: "leaf", source: `${LONG} two`, contextLines: [], nodeBytes: 140 }),
  ]);
  const texts = settled.map((r) => (r.status === "fulfilled" ? r.value : ""));
  expect(texts.filter((t) => t.includes("only-one"))).toHaveLength(1);
  expect(settled.some((r) => r.status === "rejected" || (r.status === "fulfilled" && r.value !== "only-one"))).toBe(true);
});

test("a spent daily budget does not call the runner and Memory cuts after N deferrals", async () => {
  const dir = tmpDir("nobudget");
  writeFileSync(join(dir, "compact-budget.json"), JSON.stringify({ day: new Date().toISOString().slice(0, 10), tokens: 30, calls: 1 }));
  let calls = 0;
  const compact = cursorCompressor(
    cfg(dir, { compactBatch: 1, compactBudgetTokens: 30 }),
    async () => {
      calls += 1;
      return "1. should not run";
    },
  );
  const mem = new Memory({
    dir: join(dir, "mem"),
    nodeBytes: 140,
    viewBytes: 4000,
    deferCutAfter: 2,
    deferBackoffMs: 15,
    compressor: compact,
  });
  mem.append({ kind: "user", text: LONG });
  await mem.pump();
  expect(calls).toBe(0);
  expect(existsSync(join(dir, "compact-cache.jsonl"))).toBe(false);
  await Bun.sleep(80);
  await mem.pump();
  expect(calls).toBe(0);
  const node = mem.nodeOf(0, 0);
  expect(node).toBeDefined();
  expect(node!.size).toBeLessThanOrEqual(140);
});
