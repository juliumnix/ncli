import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cursorEvalCompressor } from "../eval/memory/cursor-eval";
import { generateTranscript } from "../eval/memory/generator";
import { formatEvalAggregate, runMemoryEval, runMemoryEvalSeeds } from "../eval/memory/run";
import { CompactDeferred, cursorCompressor } from "../src/memory/cursor-compact";
import { loadConfig } from "../src/config";
import { tmpDir } from "./helpers";

test("the seeded transcript plants five needle kinds at stable indexes", () => {
  const t = generateTranscript(1, 300);
  expect(t.needles.map((n) => n.id)).toEqual(["simple", "superseded", "space", "echo", "sibling"]);
  expect(t.lines[t.needles[0].messageIndex].text).toContain("alpha file");
  expect(t.lines[t.needles[0].messageIndex].text).toContain("/tmp/ncli/alpha.json");
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
  expect(report.viewPresence).toBeLessThan(0.35);
  const mid = report.recallAtLevel["2"] ?? report.recallAtLevel["1"] ?? 1;
  expect(mid).toBeLessThan(0.5);
});

test("mock eval over five seeds reports mean and stddev above a real floor", async () => {
  const agg = await runMemoryEvalSeeds({
    n: 80,
    seeds: [1, 2, 3, 4, 5],
    viewBytes: 2500,
    nodeBytes: 280,
    dir: tmpDir("eval-mock-seeds"),
    label: "mock",
  });
  expect(agg.reports).toHaveLength(5);
  expect(agg.compactCalls.mean).toBeGreaterThan(0);
  expect(agg.reachability.mean).toBe(1);
  expect(agg.invented.mean).toBe(0);
  expect(agg.viewPresence.mean).toBeGreaterThan(0.2);
  expect(agg.viewPresence.mean).toBeLessThan(1.01);
  expect(Number.isFinite(agg.viewPresence.stddev)).toBe(true);
  expect(formatEvalAggregate(agg)).toContain("seeds=1,2,3,4,5");
  const simple = agg.reports[0]?.needles.find((n) => n.id === "simple");
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
