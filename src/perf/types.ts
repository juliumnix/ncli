export const PERF_METRICS = [
  "cold_start",
  "first_paint",
  "send_to_feedback",
  "ttft",
  "sse_token_render",
  "fork_modal_open",
  "fork_modal_close",
  "memory_drawer_open",
  "long_chat_scroll",
  "compact_turn",
] as const;

export type PerfMetricId = (typeof PERF_METRICS)[number];

export interface PerfSample {
  metric: PerfMetricId;
  ms: number;
  ok: boolean;
  harness?: string;
  work?: number;
  note?: string;
}

export interface PerfSummary {
  metric: PerfMetricId;
  n: number;
  errors: number;
  work: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export interface PerfEnv {
  cores: number;
  load: string;
  chrome: boolean;
  chromePath?: string;
}

export interface PerfReport {
  at: string;
  runs: number;
  env: PerfEnv;
  harness: string;
  metrics: PerfSummary[];
  samples: PerfSample[];
}

export interface TraceOpts {
  runs?: number;
  harness?: string;
  chrome?: boolean;
  screenshotDir?: string;
}
