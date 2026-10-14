import { expect, test } from "bun:test";
import { jobEtaLabel, jobEtaMs, jobLine, jobMeta, jobPct, jobStage, type JobProgress } from "../src/ui/job-progress";

const importRun = (over: Partial<JobProgress> = {}): JobProgress => ({
  kind: "import",
  phase: "running",
  source: "claude",
  done: 120,
  total: 480,
  startedAt: 0,
  ...over,
});

const compactRun = (over: Partial<JobProgress> = {}): JobProgress => ({
  kind: "compact",
  phase: "running",
  done: 42,
  total: 100,
  startedAt: 0,
  ...over,
});

test("import line is human language with conversation counts", () => {
  expect(jobLine(importRun())).toBe("Lendo seu histórico do Claude · 120 de 480 conversas");
  expect(jobLine(importRun({ done: 1, total: 1 }))).toBe("Lendo seu histórico do Claude · 1 de 1 conversa");
  expect(jobLine(importRun({ source: "codex", done: 0, total: 0 }))).toBe("Lendo seu histórico do Codex");
});

test("compact line is human language with a real percent", () => {
  expect(jobLine(compactRun())).toBe("Organizando a memória · 42%");
  expect(jobLine(compactRun({ done: 0, total: 0 }))).toBe("Organizando a memória");
  expect(jobLine(compactRun())).not.toMatch(/compactando/);
  expect(jobStage(compactRun({ done: 3, total: 0 }))).not.toContain("3");
});

test("provider limit pause is first-class and distinct from the daily budget", () => {
  expect(jobStage(compactRun({ phase: "paused", reason: "limit" }))).toBe("Pausado no limite");
  expect(jobLine(compactRun({ phase: "paused", reason: "limit" }))).toContain("Pausado no limite");
});

test("done and error states drop the counters", () => {
  expect(jobLine(importRun({ phase: "done" }))).toBe("Histórico do Claude pronto");
  expect(jobLine(compactRun({ phase: "done" }))).toBe("Memória organizada");
  expect(jobLine(importRun({ phase: "error", error: "boom" }))).toBe("Não deu pra ler o histórico do Claude");
  expect(jobLine(compactRun({ phase: "error" }))).toBe("Não deu pra organizar a memória");
});

test("eta appears only after a real rate exists", () => {
  expect(jobEtaMs(importRun({ startedAt: 10_000, done: 1, total: 10 }), 10_400)).toBeNull();
  expect(jobEtaMs(importRun({ startedAt: 1, done: 20, total: 80 }), 2001)).toBe(6000);
  expect(jobEtaLabel(6000)).toBe("~6s");
  expect(jobEtaLabel(70_000)).toBe("~1 min");
  expect(jobLine(importRun({ startedAt: 1, done: 20, total: 80 }), 2001)).toBe(
    "Lendo seu histórico do Claude · 20 de 80 conversas · ~6s",
  );
});

test("jobPct matches processed over total", () => {
  expect(jobPct({ done: 21, total: 50 })).toBe(42);
  expect(jobPct({ done: 0, total: 0 })).toBeNull();
});

test("import meta shows percent beside the count line", () => {
  expect(jobMeta(importRun())).toBe("25%");
  expect(jobMeta(compactRun())).toBe("");
});
