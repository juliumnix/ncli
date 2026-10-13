import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { CompactBudgetPause, CompactDeferred, cursorCompressor, estimateTokens, jobPrompt } from "../src/memory/cursor-compact";
import { Memory } from "../src/memory/store";
import { jobEtaMs, jobLine, jobStage, type JobProgress } from "../src/ui/job-progress";
import { tmpDir } from "./helpers";

const FACT = "FACT_NEEDLE_LINE_12_MEMBER_DISCOUNT";
const LONG = "billing tax member discount before tax and the invoice rule ".repeat(8);

function fatLines(n: number): Array<{ kind: "user" | "talk"; text: string }> {
  return Array.from({ length: n }, (_, i) => ({
    kind: i % 2 === 0 ? "user" as const : "talk" as const,
    text: i === 12 ? `user decided ${FACT} applies only to member` : `${LONG} ${i}`,
  }));
}

test("a 6592-line ingest is recallable before compact and seeds the tree in under a minute", async () => {
  const mem = new Memory({
    dir: tmpDir("fat-ingest"),
    nodeBytes: 80,
    viewBytes: 2500,
    compressor: async () => {
      throw new CompactDeferred();
    },
    compressTimeoutMs: 20,
    deferBackoffMs: 30_000,
    deferCutAfter: 8,
  });
  const t0 = performance.now();
  mem.ingest(fatLines(6592), { quiet: true });
  mem.publish();
  const ingestMs = performance.now() - t0;
  expect(mem.T).toBe(6592);
  expect(mem.recall(FACT).join("\n")).toContain(FACT);
  const t1 = performance.now();
  mem.seed();
  const seedMs = performance.now() - t1;
  expect(mem.recall(FACT).join("\n")).toContain(FACT);
  expect(mem.view.length).toBeGreaterThan(0);
  expect(mem.view.length).toBeLessThan(6592);
  expect(mem.viewBytesUsed()).toBeLessThanOrEqual(mem.viewHigh);
  expect(ingestMs + seedMs).toBeLessThan(60_000);
  mem.paused = true;
  console.log(`fat-ingest ingest_ms=${ingestMs.toFixed(0)} seed_ms=${seedMs.toFixed(0)} lines=${mem.T} cover=${mem.view.length} bytes=${mem.viewBytesUsed()}`);
}, 60_000);

test("SDK refine prefers recent lines over the oldest", async () => {
  const seen: string[] = [];
  const mem = new Memory({
    dir: tmpDir("recent-first"),
    nodeBytes: 40,
    viewBytes: 800,
    compactJobs: 1,
    pumpBatch: 4,
    compressor: async (input) => {
      seen.push(input.source);
      return input.source.slice(0, 36);
    },
  });
  mem.ingest(
    [0, 1, 2, 3].map((i) => ({ kind: "user" as const, text: `${LONG} LINE_${i}` })),
    { quiet: true },
  );
  await mem.pump();
  expect(seen.length).toBeGreaterThan(0);
  const first = seen.find((s) => /LINE_\d/.test(s)) ?? "";
  const last = [...seen].reverse().find((s) => /LINE_\d/.test(s)) ?? "";
  expect(first).toContain("LINE_3");
  expect(last).toContain("LINE_0");
  mem.paused = true;
});

test("cursorCompressor runs token batches in parallel up to compactJobs", async () => {
  const dir = tmpDir("cpar");
  let inflight = 0;
  let max = 0;
  const compact = cursorCompressor(
    loadConfig({
      dataDir: dir,
      compactBackend: "cursor",
      compactBatch: 2,
      compactJobs: 4,
      compactDebounceMs: 5,
      compactSkipTokens: 1,
    }),
    async () => {
      inflight += 1;
      max = Math.max(max, inflight);
      await Bun.sleep(40);
      inflight -= 1;
      return "1. a\n2. b";
    },
  );
  const jobs = Array.from({ length: 8 }, (_, i) =>
    compact({ kind: "leaf", source: `${LONG} ${i}`, contextLines: [], nodeBytes: 140 }),
  );
  await Promise.all(jobs);
  expect(max).toBeGreaterThanOrEqual(3);
});

test("one shared <chat> lets a batch hold tens of items under the 60k cap", () => {
  const chat = Array.from({ length: 40 }, (_, i) => `${i}+1|cover line ${i}`).join("\n");
  const jobs = Array.from({ length: 40 }, (_, i) => ({
    input: {
      kind: "leaf" as const,
      source: `user: ${LONG} ${i}`,
      contextLines: chat.split("\n"),
      nodeBytes: 140,
    },
  }));
  const prompt = jobPrompt(jobs);
  expect((prompt.match(/<\/chat>/g) || []).length).toBe(1);
  expect(estimateTokens(prompt)).toBeLessThan(60_000);
  expect(estimateTokens(prompt)).toBeGreaterThan(4_000);
});

test("daily budget pause is a first-class compact phase, not a stuck bar", () => {
  const job: JobProgress = {
    kind: "compact",
    phase: "paused",
    done: 90,
    total: 500,
    startedAt: 1,
    error: undefined,
  };
  expect(jobStage(job)).toContain("Pausado");
  expect(jobLine(job)).toContain("limite diário");
  expect(jobLine(job)).toContain("18%");
  expect(jobLine(job)).toContain("continua amanhã");
  expect(jobEtaMs(job, 60_000)).toBeNull();
});

test("ETA uses real done/elapsed and percent moves when done moves", () => {
  const start = 1_000;
  const a: JobProgress = { kind: "compact", phase: "running", done: 80, total: 400, startedAt: start };
  const b: JobProgress = { kind: "compact", phase: "running", done: 160, total: 400, startedAt: start };
  expect(jobLine(a)).toContain("20%");
  expect(jobLine(b)).toContain("40%");
  const etaA = jobEtaMs(a, start + 10_000);
  const etaB = jobEtaMs(b, start + 10_000);
  expect(etaA).toBe(40_000);
  expect(etaB).toBe(15_000);
  expect(etaB!).toBeLessThan(etaA!);
});

test("Memory marks budget pause and keeps the local cut", async () => {
  const mem = new Memory({
    dir: tmpDir("budget-pause"),
    nodeBytes: 40,
    viewBytes: 800,
    compressor: async () => {
      throw new CompactBudgetPause();
    },
  });
  mem.ingest([{ kind: "user", text: LONG }], { quiet: true });
  await mem.pump();
  expect(mem.nodeOf(0, 0)?.text).toBeDefined();
  expect(mem.compactWork.paused).toBe("budget");
  expect(mem.compactWork.total).toBeGreaterThan(0);
  mem.paused = true;
});
