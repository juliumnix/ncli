import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import {
  CURSOR_COMPACT_PROMPT,
  CompactDeferred,
  cursorCompressor,
  estimateTokens,
  jobPrompt,
  nodeHash,
  parseCursorPrint,
  parseNumbered,
  splitJobsByTokens,
} from "../src/memory/cursor-compact";
import { Memory } from "../src/memory/store";
import { tmpDir } from "./helpers";

const LONG = "user decided FACT_MEMBER_DISCOUNT_BEFORE_TAX applies only to member and before tax. ".repeat(4);

function cfg(dir: string, extra: Record<string, unknown> = {}) {
  return loadConfig({
    dataDir: dir,
    compactBackend: "cursor",
    compactBatch: 2,
    compactDebounceMs: 20,
    compactSkipTokens: 8,
    compactBudgetTokens: 250000,
    compactModel: "composer-2.5",
    nodeBytes: 140,
    ...extra,
  });
}

test("parseNumbered and parseCursorPrint recover a cheap one-line batch", () => {
  expect(parseNumbered("1. first fact\n2. second fact", 2)).toEqual(["first fact", "second fact"]);
  expect(parseNumbered("1. only", 2)).toEqual(["only", ""]);
  expect(parseNumbered("1. a\n3. c", 3)).toEqual(["a", "", "c"]);
  expect(parseCursorPrint(JSON.stringify({ result: "one line memory" }))).toBe("one line memory");
  expect(parseCursorPrint("plain line")).toBe("plain line");
});

test("jobPrompt shows the chat and forbids adding what input lacks", () => {
  const prompt = jobPrompt([{
    input: {
      kind: "leaf",
      source: "user: hello",
      contextLines: ["0+1|older line"],
      nodeBytes: 32,
    },
  }]);
  expect(prompt).toContain("<chat>");
  expect(prompt).toContain("0+1|older line");
  expect(prompt).toContain("never add what");
  expect(prompt).toContain("-".repeat(32));
});

test("a source that already fits is never sent to the Cursor runner", async () => {
  const dir = tmpDir("cskip");
  let calls = 0;
  const compact = cursorCompressor(cfg(dir, { compactSkipTokens: 1 }), async () => {
    calls += 1;
    return "1. should not run";
  });
  const mem = new Memory({
    dir: join(dir, "mem"),
    nodeBytes: 140,
    viewBytes: 2000,
    compressor: compact,
  });
  mem.append({ kind: "user", text: "curto" });
  await mem.pump();
  expect(calls).toBe(0);
  expect(mem.nodeOf(0, 0)?.text).toBe("user: curto");
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
    expect(model).toBe("composer-2.5");
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
  expect(row.model).toBe("composer-2.5");
});

test("a spent compact-budget.json does not pause when no daily cap is set", async () => {
  const dir = tmpDir("nocap");
  writeFileSync(join(dir, "compact-budget.json"), JSON.stringify({
    day: new Date().toISOString().slice(0, 10),
    tokens: 400000,
    calls: 20,
  }));
  let calls = 0;
  const compact = cursorCompressor(
    cfg(dir, { compactBatch: 1, compactSkipTokens: 1, compactBudgetTokens: 0 }),
    async () => {
      calls += 1;
      return "1. ok";
    },
  );
  const text = await compact({ kind: "leaf", source: LONG, contextLines: [], nodeBytes: 140 });
  expect(calls).toBe(1);
  expect(text).toBe("ok");
});

test("daily budget stops further Cursor calls and leaves the node unbuilt", async () => {
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
  let rejected = false;
  try {
    await compact({
      kind: "leaf",
      source: `${LONG} another distinct node`,
      contextLines: [],
      nodeBytes: 140,
    });
  } catch {
    rejected = true;
  }
  expect(calls).toBe(1);
  expect(rejected).toBe(true);
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

test("a skipped merge keeps the recent right child, not the left prefix", async () => {
  const dir = tmpDir("cskip-recent");
  const compact = cursorCompressor(cfg(dir, { compactSkipTokens: 80 }), async () => {
    throw new Error("runner should not run");
  });
  const left = "AAAA old left child text that would survive a prefix cut";
  const right = "BBBB most recent ruling END_RIGHT_CHILD";
  const line = await compact({
    kind: "merge",
    source: `${left}\n${right}`,
    left,
    right,
    contextLines: [],
    nodeBytes: 40,
  });
  expect(line).toContain("END_RIGHT_CHILD");
  expect(line).not.toContain("AAAA");
});

test("debounce holds a job so a later sibling shares one Cursor call", async () => {
  const dir = tmpDir("cdebounce");
  let calls = 0;
  const compact = cursorCompressor(cfg(dir, { compactBatch: 8, compactDebounceMs: 80, compactSkipTokens: 1 }), async () => {
    calls += 1;
    return "1. first\n2. second";
  });
  const a = compact({ kind: "leaf", source: LONG, contextLines: [], nodeBytes: 140 });
  await Bun.sleep(20);
  expect(calls).toBe(0);
  const b = compact({ kind: "leaf", source: `${LONG} sibling`, contextLines: [], nodeBytes: 140 });
  expect(await a).toBe("first");
  expect(await b).toBe("second");
  expect(calls).toBe(1);
});

test("a source under the skip token threshold never hits the runner", async () => {
  const dir = tmpDir("cskip-tokens");
  let calls = 0;
  const compact = cursorCompressor(cfg(dir, { compactSkipTokens: 80 }), async () => {
    calls += 1;
    return "1. should not run";
  });
  const source = "user decided a short fact about billing ".repeat(4);
  expect(estimateTokens(source)).toBeLessThanOrEqual(80);
  const line = await compact({ kind: "leaf", source, contextLines: [], nodeBytes: 140 });
  expect(calls).toBe(0);
  expect(line.length).toBeGreaterThan(0);
});

test("splitJobsByTokens keeps every cursor-agent prompt under the 100k surcharge line", async () => {
  const chunk = "FACT_MEMBER_DISCOUNT_BEFORE_TAX ".repeat(400);
  const jobs = [1, 2, 3].map((n) => ({
    input: { kind: "leaf" as const, source: `${chunk} ${n}`, contextLines: [], nodeBytes: 140 },
  }));
  const one = estimateTokens(jobPrompt(jobs.slice(0, 1)));
  const cap = one + 80;
  expect(one).toBeLessThan(cap);
  expect(estimateTokens(jobPrompt(jobs))).toBeGreaterThan(cap);
  const batches = splitJobsByTokens(jobs, { maxItems: 6, maxInputTokens: cap });
  expect(batches.length).toBeGreaterThan(1);
  for (const batch of batches) {
    expect(estimateTokens(jobPrompt(batch))).toBeLessThanOrEqual(cap);
    expect(batch.length).toBeGreaterThan(0);
  }

  const dir = tmpDir("ccap");
  const prompts: string[] = [];
  const compact = cursorCompressor(
    cfg(dir, { compactBatch: 6, compactSkipTokens: 1, compactMaxInputTokens: cap }),
    async (prompt) => {
      prompts.push(prompt);
      return "1. line";
    },
  );
  await Promise.all(jobs.map((j) => compact(j.input)));
  expect(prompts.length).toBeGreaterThan(1);
  for (const p of prompts) expect(estimateTokens(p)).toBeLessThanOrEqual(cap);
});
