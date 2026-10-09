import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import {
  CURSOR_COMPACT_PROMPT,
  cursorCompressor,
  estimateTokens,
  nodeHash,
  parseCursorPrint,
  parseNumbered,
} from "../src/memory/cursor-compact";
import { tmpDir } from "./helpers";

const LONG = "user decided FACT_MEMBER_DISCOUNT_BEFORE_TAX applies only to member and before tax. ".repeat(4);

function cfg(dir: string, extra: Record<string, unknown> = {}) {
  return loadConfig({
    dataDir: dir,
    compactBackend: "cursor",
    compactBatch: 2,
    compactSkipTokens: 8,
    compactBudgetTokens: 250000,
    compactModel: "claude-haiku-5-5-low",
    nodeBytes: 140,
    ...extra,
  });
}

test("parseNumbered and parseCursorPrint recover a cheap one-line batch", () => {
  expect(parseNumbered("1. first fact\n2. second fact", 2)).toEqual(["first fact", "second fact"]);
  expect(parseCursorPrint(JSON.stringify({ result: "one line memory" }))).toBe("one line memory");
  expect(parseCursorPrint("plain line")).toBe("plain line");
});

test("tiny nodes skip the Cursor CLI and still return a line", async () => {
  const dir = tmpDir("cskip");
  let calls = 0;
  const compact = cursorCompressor(cfg(dir), async () => {
    calls += 1;
    return "should not run";
  });
  const line = await compact({
    kind: "leaf",
    source: "curto",
    contextLines: [],
    nodeBytes: 140,
  });
  expect(calls).toBe(0);
  expect(line).toContain("curto");
  const log = readFileSync(join(dir, "compact-log.jsonl"), "utf8");
  expect(log).toContain("\"skipped\":1");
});

test("identical nodes hit the hash cache so the runner runs once", async () => {
  const dir = tmpDir("ccache");
  let calls = 0;
  const compact = cursorCompressor(cfg(dir, { compactBatch: 1, compactSkipTokens: 1 }), async () => {
    calls += 1;
    return "1. cached line about discount";
  });
  const input = { kind: "leaf" as const, source: LONG, contextLines: [], nodeBytes: 140 };
  const a = await compact(input);
  const b = await compact(input);
  expect(a).toBe(b);
  expect(calls).toBe(1);
  expect(nodeHash(input).length).toBe(24);
  expect(existsSync(join(dir, "compact-cache.jsonl"))).toBe(true);
});

test("a full batch is one Cursor call with a short numbered prompt", async () => {
  const dir = tmpDir("cbatch");
  const prompts: string[] = [];
  const compact = cursorCompressor(cfg(dir, { compactSkipTokens: 1 }), async (prompt, model) => {
    prompts.push(prompt);
    expect(model).toBe("claude-haiku-5-5-low");
    return "1. leaf one\n2. leaf two";
  });
  const [a, b] = await Promise.all([
    compact({ kind: "leaf", source: `${LONG} one`, contextLines: [], nodeBytes: 140 }),
    compact({ kind: "leaf", source: `${LONG} two`, contextLines: [], nodeBytes: 140 }),
  ]);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(CURSOR_COMPACT_PROMPT);
  expect(prompts[0]).toContain("Output 2 lines");
  expect(a).toContain("leaf one");
  expect(b).toContain("leaf two");
  const row = JSON.parse(readFileSync(join(dir, "compact-log.jsonl"), "utf8").trim().split("\n").at(-1)!);
  expect(row.items).toBe(2);
  expect(row.tokensIn).toBeGreaterThan(0);
  expect(row.model).toBe("claude-haiku-5-5-low");
});

test("daily budget stops further Cursor calls and falls back to a cut line", async () => {
  const dir = tmpDir("cbudget");
  let calls = 0;
  const compact = cursorCompressor(
    cfg(dir, { compactBatch: 1, compactSkipTokens: 1, compactBudgetTokens: 30 }),
    async () => {
      calls += 1;
      return "1. " + "x".repeat(80);
    },
  );
  await compact({ kind: "leaf", source: LONG, contextLines: [], nodeBytes: 140 });
  expect(calls).toBe(1);
  const second = await compact({
    kind: "leaf",
    source: `${LONG} another distinct node`,
    contextLines: [],
    nodeBytes: 140,
  });
  expect(calls).toBe(1);
  expect(second.length).toBeGreaterThan(0);
});

test("queueing a compact job does not block; the runner runs later", async () => {
  const dir = tmpDir("casync");
  let started = 0;
  let release!: (s: string) => void;
  const gate = new Promise<string>((r) => {
    release = r;
  });
  const compact = cursorCompressor(cfg(dir, { compactBatch: 1, compactSkipTokens: 1 }), async () => {
    started += 1;
    return gate;
  });
  let done = false;
  const pending = compact({ kind: "leaf", source: LONG, contextLines: [], nodeBytes: 140 }).then((line) => {
    done = true;
    return line;
  });
  await Bun.sleep(30);
  expect(started).toBe(1);
  expect(done).toBe(false);
  release("1. later");
  expect(await pending).toContain("later");
  expect(done).toBe(true);
});

test("estimateTokens is cheap and positive", () => {
  expect(estimateTokens("abcd")).toBeGreaterThan(0);
  expect(estimateTokens("")).toBe(1);
});
