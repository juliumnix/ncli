import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cursorEvalCompressor } from "../eval/memory/cursor-eval";
import { generateTranscript } from "../eval/memory/generator";
import { ciHigh, ciLow, fakeCursorRunner, formatEvalAggregate, runMemoryEval, runMemoryEvalSeeds } from "../eval/memory/run";
import { CompactDeferred, cursorCompressor } from "../src/memory/cursor-compact";
import { loadConfig } from "../src/config";
import { flattenLine, keepRecent } from "../src/util";
import { tmpDir } from "./helpers";

test("the seeded transcript plants five needle kinds at stable indexes", () => {
  const t = generateTranscript(1, 300);
  expect(t.needles.map((n) => n.id)).toEqual(["simple", "superseded", "space", "echo", "sibling"]);
  const simple = t.lines[t.needles[0].messageIndex].text;
  expect(simple).toContain("alpha file");
  expect(simple).toContain("/tmp/ncli/alpha.json");
  expect(simple.slice(0, 80)).not.toContain("/tmp/ncli/alpha.json");
  expect(t.lines.some((l) => l.text.includes("rate is now 7"))).toBe(true);
  expect(t.lines.some((l) => l.text.includes("other-space-token"))).toBe(true);
  expect(t.lines.some((l) => l.text.includes("sibling bug"))).toBe(true);
  expect(t.needles.flatMap((n) => n.tokens).every((tok) => !/^[A-Z][A-Z0-9_]{7,}$/.test(tok))).toBe(true);
  expect(t.needles.find((n) => n.id === "echo")?.inEcho).toBe(true);
  expect(t.needles.every((n) => n.question.length > 0 && n.answer.length > 0)).toBe(true);
});

test("a compressor that drops every token must drop the score", async () => {
  const report = await runMemoryEval({
    n: 80,
    seed: 1,
    viewBytes: 800,
    nodeBytes: 280,
    dir: tmpDir("eval-broken"),
    label: "broken",
    compressor: async () => "x",
  });
  expect(report.compactCalls).toBeGreaterThan(0);
  expect(report.quiescent).toBe(true);
  expect(report.deferred).toBe(0);
  expect(report.viewPresence).toBeLessThan(0.35);
  const mid = report.recallAtLevel["2"] ?? report.recallAtLevel["1"] ?? 1;
  expect(mid).toBeLessThan(0.5);
});

test("mock beats a 40-byte prefix truncator by confidence interval", async () => {
  const seeds = [1, 2, 3, 4, 5];
  const mock = await runMemoryEvalSeeds({
    n: 80,
    seeds,
    viewBytes: 2500,
    nodeBytes: 280,
    dir: tmpDir("eval-mock-seeds"),
    label: "mock",
  });
  const trunc = await runMemoryEvalSeeds({
    n: 80,
    seeds,
    viewBytes: 2500,
    nodeBytes: 280,
    dir: tmpDir("eval-trunc-seeds"),
    label: "prefix-40",
    compressor: async (input) => flattenLine(input.source).slice(0, 40),
  });
  expect(mock.reports).toHaveLength(5);
  expect(mock.compactCalls.mean).toBeGreaterThan(0);
  expect(mock.reachability.mean).toBe(1);
  expect(mock.invented.mean).toBe(0);
  expect(mock.reports.every((r) => r.quiescent && r.deferred === 0)).toBe(true);
  expect(ciLow(mock.leafPresence, seeds.length)).toBeGreaterThan(ciHigh(trunc.leafPresence, seeds.length));
  expect(mock.leafPresence.mean).toBe(1);
  expect(trunc.leafPresence.mean).toBe(0);
  expect(formatEvalAggregate(mock)).toContain("seeds=1,2,3,4,5");
  const simple = mock.reports[0]?.needles.find((n) => n.id === "simple");
  expect(simple?.answerInLeaf).toBe(true);
});

test("cursorCompressor fake runner eval goes through jobPrompt, numbered parse, and budget defer", async () => {
  const dir = tmpDir("eval-cursor");
  const prompts: string[] = [];
  const compact = cursorEvalCompressor(dir, {
    onPrompt: (prompt) => prompts.push(prompt),
  });
  const report = await runMemoryEval({
    n: 40,
    seed: 2,
    viewBytes: 1200,
    nodeBytes: 280,
    dir: join(dir, "mem"),
    label: "cursor-fake",
    compressor: compact,
  });
  expect(report.quiescent).toBe(true);
  expect(report.deferred).toBe(0);
  expect(report.settled).toBe(true);
  expect(report.compactCalls).toBeGreaterThan(0);
  expect(prompts.length).toBeGreaterThan(0);
  expect(prompts.some((p) => p.includes("Output") && p.includes("###"))).toBe(true);
  expect(report.reachability).toBe(1);
  expect(report.invented).toBeLessThan(report.compactCalls);

  const spent = tmpDir("eval-cursor-budget");
  writeFileSync(join(spent, "compact-budget.json"), JSON.stringify({
    day: new Date().toISOString().slice(0, 10),
    tokens: 40,
    calls: 2,
  }));
  mkdirSync(spent, { recursive: true });
  let calls = 0;
  const limited = cursorCompressor(
    loadConfig({
      dataDir: spent,
      compactBatch: 1,
      compactDebounceMs: 5,
      compactSkipTokens: 1,
      compactBudgetTokens: 40,
    }),
    async () => {
      calls += 1;
      return "1. should not run";
    },
  );
  let deferred = false;
  try {
    await limited({
      kind: "leaf",
      source: `${"long overflow line for the budget path ".repeat(8)} token-88421`,
      contextLines: [],
      nodeBytes: 140,
    });
  } catch (err) {
    deferred = err instanceof CompactDeferred;
  }
  expect(calls).toBe(0);
  expect(deferred).toBe(true);
});

test("fake cursor runner keeps the recent side inside nodeBytes and does not harvest needle tokens", () => {
  const prompt = [
    "Output 1 lines, numbered 1..1. Nothing else.",
    "",
    "### 1 (max 40 bytes)",
    "----------------------------------------",
    "<chat>",
    "</chat>",
    "Compress:",
    "<input>",
    `${"padding about billing lint chores. ".repeat(8)}late-needle-alpha.json`,
    "</input>",
  ].join("\n");
  const out = fakeCursorRunner(prompt);
  expect(out.startsWith("1. ")).toBe(true);
  const body = out.slice(3);
  expect(body.includes("late-needle-alpha.json")).toBe(true);
  expect(keepRecent(`${"padding about billing lint chores. ".repeat(8)}late-needle-alpha.json`, 40)).toBe(body);
  expect(body.length).toBeLessThanOrEqual(40);
});
