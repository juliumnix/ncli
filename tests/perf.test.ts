import { expect, test } from "bun:test";
import { percentile, summarize } from "../src/perf/stats";
import { measureCompactImpact, measureSendPath } from "../src/perf/server-trace";
import { nextPort } from "../src/perf/run";
import type { PerfSample } from "../src/perf/types";

test("percentile is the interpolated rank of the sorted samples", () => {
  expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  expect(percentile([10, 20], 50)).toBe(15);
  expect(percentile([8], 95)).toBe(8);
});

test("summarize prints p50/p95 and counts errors separately from work", () => {
  const samples: PerfSample[] = [
    { metric: "ttft", ms: 10, ok: true, work: 3 },
    { metric: "ttft", ms: 12, ok: true, work: 3 },
    { metric: "ttft", ms: 40, ok: true, work: 3 },
    { metric: "ttft", ms: 0, ok: false, work: 0 },
  ];
  const s = summarize("ttft", samples);
  expect(s.n).toBe(4);
  expect(s.errors).toBe(1);
  expect(s.work).toBe(9);
  expect(s.p50).toBe(12);
  expect(s.min).toBe(10);
  expect(s.max).toBe(40);
});

test("POST /api/message yields a user or turn event then a token on the mock harness", async () => {
  const samples = await measureSendPath(nextPort());
  const feedback = samples.find((s) => s.metric === "send_to_feedback");
  const ttft = samples.find((s) => s.metric === "ttft");
  expect(feedback?.ok).toBe(true);
  expect(ttft?.ok).toBe(true);
  expect(feedback?.ms ?? 999).toBeLessThan(400);
  expect(ttft?.ms ?? 999).toBeLessThan(800);
  expect((ttft?.work ?? 0) >= 1).toBe(true);
});

test("a slow memory.pump does not hold the first running turn", async () => {
  const sample = await measureCompactImpact(nextPort());
  expect(sample.ok).toBe(true);
  expect(sample.ms).toBeLessThan(80);
});
