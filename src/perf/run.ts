import { cpus, loadavg } from "node:os";
import { chromePath } from "./cdp";
import { browserAvailable, measureBrowser } from "./chrome-trace";
import { measureColdStart, measureCompactImpact, measureForkApi, measureSendPath, bootTracedHub } from "./server-trace";
import { summarize } from "./stats";
import { PERF_METRICS, type PerfEnv, type PerfReport, type PerfSample, type TraceOpts } from "./types";

export function perfEnv(): PerfEnv {
  const bin = chromePath();
  return {
    cores: cpus().length,
    load: loadavg().map((n) => n.toFixed(2)).join(" "),
    chrome: Boolean(bin),
    chromePath: bin,
  };
}

export function nextPort(base = 21000): number {
  return base + Math.floor(Math.random() * 2000);
}

export async function runPerf(opts: TraceOpts = {}): Promise<PerfReport> {
  const runs = Math.max(1, opts.runs ?? 7);
  const harness = opts.harness ?? "mock";
  const useChrome = opts.chrome ?? browserAvailable();
  const samples: PerfSample[] = [];
  const env = perfEnv();

  for (let i = 0; i < runs; i++) {
    samples.push(await measureColdStart(nextPort()));
    const send = await measureSendPath(nextPort());
    samples.push(...(useChrome ? send.filter((s) => s.metric !== "send_to_feedback") : send));
    samples.push(await measureCompactImpact(nextPort()));
    if (!useChrome) samples.push(...(await measureForkApi(nextPort())));
  }

  if (useChrome) {
    const empty = await bootTracedHub({ port: nextPort() });
    try {
      for (let i = 0; i < runs; i++) {
        const shot = i === 0 ? opts.screenshotDir : undefined;
        const browser = await measureBrowser(empty.uiUrl, shot);
        samples.push(...browser.filter((s) => s.metric !== "long_chat_scroll"));
      }
    } finally {
      empty.stop();
    }
    const long = await bootTracedHub({ port: nextPort(), seedMessages: 500 });
    try {
      for (let i = 0; i < runs; i++) {
        const browser = await measureBrowser(long.uiUrl);
        samples.push(...browser.filter((s) => s.metric === "long_chat_scroll"));
      }
    } finally {
      long.stop();
    }
  }

  const metrics = PERF_METRICS.map((id) => summarize(id, samples)).filter((s) => s.n > 0);
  return {
    at: new Date().toISOString(),
    runs,
    env: { ...env, chrome: useChrome && env.chrome },
    harness,
    metrics,
    samples,
  };
}

export function documentRealHarness(): string {
  return [
    "CI and `bun run perf` use the mock harness.",
    "To time a real seat, start NCLI with that harness. The official binaries stay untouched:",
    "",
    "  NCLI_HARNESS=claude bun start",
    "",
    "Claude stays on the official `claude -p` binary. Codex is `codex exec --json`.",
    "Cursor is `cursor-agent acp`. NCLI never writes ~/.claude, ~/.codex, or ~/.cursor.",
  ].join("\n");
}
