import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootNcli } from "../boot";
import { loadConfig } from "../config";
import { Hub } from "../hub";
import { MockHarness } from "../harness/mock";
import { initTempRepo } from "../sparks/worktree";
import type { HubEvent } from "../types";
import type { PerfSample } from "./types";

export interface ServerTrace {
  samples: PerfSample[];
  uiUrl: string;
  stop(): void;
}

function dataRoot(label: string): string {
  const dir = join(tmpdir(), `ncli-perf-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function bootTracedHub(opts: {
  port: number;
  demo?: boolean;
  seedMessages?: number;
}): Promise<{ hub: Hub; uiUrl: string; stop: () => void; dataDir: string }> {
  const dataDir = dataRoot("hub");
  const repo = await initTempRepo();
  const cfg = loadConfig({
    dataDir,
    repo,
    ncliRoot: process.cwd(),
    harness: "mock",
    demo: opts.demo ?? false,
    ghMode: "mock",
    port: opts.port,
    host: "127.0.0.1",
  });
  const hub = new Hub(cfg, join(process.cwd(), "views"), join(process.cwd(), "fixtures/gh"), new MockHarness());
  if (opts.seedMessages) {
    for (let i = 0; i < opts.seedMessages; i++) {
      hub.memory.append({
        kind: i % 2 === 0 ? "user" : "talk",
        text: `linha ${i} do chat longo para o scroll. FACT_PERF_${i} texto extra para o bubble ter altura.`,
        date: new Date(Date.now() - (opts.seedMessages - i) * 1000).toISOString(),
      });
    }
  }
  const booted = await bootNcli({ cfg, hub, root: process.cwd() });
  return {
    hub,
    uiUrl: booted.report.uiUrl,
    dataDir,
    stop() {
      booted.stop();
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

export async function measureColdStart(port: number): Promise<PerfSample> {
  const dataDir = dataRoot("cold");
  const repo = await initTempRepo();
  const env = {
    ...process.env,
    NCLI_HARNESS: "mock",
    NCLI_DEMO: "0",
    NCLI_GH: "mock",
    NCLI_PORT: String(port),
    NCLI_HOST: "127.0.0.1",
    NCLI_DATA: dataDir,
    NCLI_REPO: repo,
  };
  const started = performance.now();
  const child = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitHttp(`http://127.0.0.1:${port}/`, 15000);
    const ms = performance.now() - started;
    const html = await fetch(`http://127.0.0.1:${port}/`);
    const ok = html.ok && (await html.text()).includes("id=\"log\"");
    return { metric: "cold_start", ms, ok, work: ok ? 1 : 0, harness: "mock" };
  } finally {
    child.kill();
    await child.exited;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }
}

export async function measureSendPath(port: number): Promise<PerfSample[]> {
  const traced = await bootTracedHub({ port });
  try {
    const samples: PerfSample[] = [];
    const url = traced.uiUrl;
    const events: Array<{ t: number; ev: HubEvent }> = [];
    const unsub = traced.hub.subscribe((ev) => {
      events.push({ t: performance.now(), ev });
    });
    const t0 = performance.now();
    const res = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "oi perf" }),
    });
    await waitUntil(
      () => events.some((e) => e.ev.type === "message" && e.ev.message.kind === "talk"),
      8000,
    );
    unsub();
    const feedback = events.find((e) => e.ev.type === "message" || e.ev.type === "turn");
    const firstDelta = events.find((e) => e.ev.type === "delta" && e.ev.text.length > 0);
    const deltas = events.filter((e) => e.ev.type === "delta" && e.ev.text.length > 0);
    let gap = 0;
    for (let i = 1; i < deltas.length; i++) {
      gap = Math.max(gap, deltas[i]!.t - deltas[i - 1]!.t);
    }
    samples.push({
      metric: "send_to_feedback",
      ms: feedback ? feedback.t - t0 : 0,
      ok: res.ok && Boolean(feedback),
      work: events.filter((e) => e.ev.type === "message" || e.ev.type === "turn").length,
    });
    samples.push({
      metric: "ttft",
      ms: firstDelta ? firstDelta.t - t0 : 0,
      ok: Boolean(firstDelta),
      work: deltas.length,
      harness: "mock",
    });
    samples.push({
      metric: "sse_token_render",
      ms: gap,
      ok: deltas.length > 1,
      work: deltas.length,
      note: "max inter-delta gap at hub emit",
    });
    return samples;
  } finally {
    traced.stop();
  }
}

export async function measureCompactImpact(port: number): Promise<PerfSample> {
  const traced = await bootTracedHub({ port, seedMessages: 16 });
  try {
    const orig = traced.hub.memory.pump.bind(traced.hub.memory);
    traced.hub.memory.pump = async () => {
      await Bun.sleep(80);
      return orig();
    };
    const marks: number[] = [];
    traced.hub.subscribe((ev) => {
      if (ev.type === "turn" && ev.turn.status === "running" && marks.length === 0) {
        marks.push(performance.now());
      }
    });
    const t0 = performance.now();
    const send = traced.hub.send("o compacto deve ficar fora do turno");
    await waitUntil(() => marks.length > 0, 4000);
    const ms = (marks[0] ?? performance.now()) - t0;
    await send;
    traced.hub.memory.pump = orig;
    try {
      await orig();
    } catch {}
    return {
      metric: "compact_turn",
      ms,
      ok: ms < 80,
      work: 1,
      note: "first running turn while memory.pump sleeps 80ms",
    };
  } finally {
    traced.stop();
  }
}

export async function measureForkApi(port: number): Promise<PerfSample[]> {
  const traced = await bootTracedHub({ port });
  try {
    const tOpen = performance.now();
    const opened = await fetch(`${traced.uiUrl}/api/forks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: "live", params: {} }),
    });
    const json = (await opened.json()) as { fork?: { id?: string } };
    const openMs = performance.now() - tOpen;
    const id = json.fork?.id ?? "";
    const tGet = performance.now();
    const got = id ? await fetch(`${traced.uiUrl}/api/forks/${encodeURIComponent(id)}`) : null;
    const getMs = performance.now() - tGet;
    return [
      {
        metric: "fork_modal_open",
        ms: openMs + getMs,
        ok: opened.ok && Boolean(got?.ok),
        work: got?.ok ? 1 : 0,
        note: "POST /api/forks + GET detail, no chrome",
      },
    ];
  } finally {
    traced.stop();
  }
}

async function waitHttp(url: string, ms: number): Promise<void> {
  const start = Date.now();
  let last = "not started";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(40);
  }
  throw new Error(`server did not answer ${url}: ${last}`);
}

async function waitUntil(fn: () => boolean, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await Bun.sleep(5);
  }
  throw new Error("timeout");
}
