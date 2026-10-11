import type { PerfMetricId, PerfSample, PerfSummary } from "./types";

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const t = idx - lo;
  return sorted[lo]! * (1 - t) + sorted[hi]! * t;
}

export function summarize(metric: PerfMetricId, samples: PerfSample[]): PerfSummary {
  const mine = samples.filter((s) => s.metric === metric);
  const ok = mine.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  const work = mine.reduce((n, s) => n + (s.work ?? (s.ok ? 1 : 0)), 0);
  return {
    metric,
    n: mine.length,
    errors: mine.filter((s) => !s.ok).length,
    work,
    p50: percentile(ok, 50),
    p95: percentile(ok, 95),
    min: ok[0] ?? 0,
    max: ok.at(-1) ?? 0,
  };
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

export function formatTable(summaries: PerfSummary[]): string {
  const rows = [
    "metric                  n  err     p50     p95     min     max   work",
    "---------------------- --  ---  ------  ------  ------  ------  ----",
  ];
  for (const s of summaries) {
    const name = s.metric.padEnd(22);
    const n = String(s.n).padStart(2);
    const err = String(s.errors).padStart(3);
    const p50 = formatMs(s.p50).padStart(6);
    const p95 = formatMs(s.p95).padStart(6);
    const min = formatMs(s.min).padStart(6);
    const max = formatMs(s.max).padStart(6);
    const work = String(s.work).padStart(4);
    rows.push(`${name} ${n}  ${err}  ${p50}  ${p95}  ${min}  ${max}  ${work}`);
  }
  return rows.join("\n");
}
