import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { bootNcli } from "../boot";
import { loadConfig } from "../config";
import { Hub } from "../hub";
import { MockHarness } from "../harness/mock";
import { Importer } from "../import";
import { initTempRepo } from "../sparks/worktree";
import { chromePath, launchChrome, type CdpSession } from "./cdp";
import { nextPort } from "./run";
import { percentile } from "./stats";

export const ONBOARD_METRICS = [
  "import_preview",
  "hub_start",
  "bunx_ready",
  "welcome_paint",
  "import_ready",
  "import_apply",
  "first_reply",
  "pr_open",
  "onboard_total",
] as const;

export type OnboardMetric = (typeof ONBOARD_METRICS)[number];

export interface OnboardSample {
  metric: OnboardMetric;
  ms: number;
  ok: boolean;
  work: number;
  note?: string;
}

export interface OnboardSummary {
  metric: OnboardMetric;
  n: number;
  errors: number;
  work: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export interface OnboardReport {
  at: string;
  runs: number;
  cores: number;
  load: string;
  chrome: boolean;
  metrics: OnboardSummary[];
  samples: OnboardSample[];
}

const FIXTURE_CLAUDE = join(import.meta.dir, "../../fixtures/import/claude/projects");
const PR_URL = "https://github.com/acme/shop/pull/482";
const FIRST_Q = "oi, me responde rápido";

export function writeFatClaude(root: string, files: number, linesPer = 8): number {
  mkdirSync(join(root, "projects", "fat"), { recursive: true });
  let lines = 0;
  for (let i = 0; i < files; i++) {
    const rows: string[] = [];
    for (let j = 0; j < linesPer; j++) {
      const kind = j % 2 === 0 ? "user" : "assistant";
      const role = kind === "user" ? "user" : "assistant";
      rows.push(
        JSON.stringify({
          uuid: `fat-${i}-${j}`,
          sessionId: `sess-fat-${i}`,
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, i, j)).toISOString(),
          type: kind,
          cwd: "/tmp/fat",
          message: { role, content: [{ type: "text", text: `FACT_FAT_${i}_${j}` }] },
        }),
      );
      lines += 1;
    }
    writeFileSync(join(root, "projects", "fat", `sess-${i}.jsonl`), rows.join("\n"));
  }
  return lines;
}

function tmp(label: string): string {
  const dir = join(tmpdir(), `ncli-onboard-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function emptyImport(): string {
  const dir = tmp("empty-import");
  return dir;
}

async function makeOnboardHub(opts: {
  port: number;
  claude: string;
  start?: boolean;
}): Promise<{ hub: Hub; dataDir: string; repo: string; stop: () => void }> {
  const dataDir = tmp("data");
  const repo = await initTempRepo();
  const empty = emptyImport();
  const cfg = loadConfig({
    dataDir,
    repo,
    ncliRoot: process.cwd(),
    harness: "mock",
    demo: false,
    ghMode: "mock",
    port: opts.port,
    host: "127.0.0.1",
    importClaude: opts.claude,
    importCodex: empty,
    importCursor: empty,
  });
  const hub = new Hub(cfg, join(process.cwd(), "views"), join(process.cwd(), "fixtures/gh"), new MockHarness());
  if (opts.start !== false) await hub.start();
  return {
    hub,
    dataDir,
    repo,
    stop() {
      hub.close();
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

export function measureImportPreview(opts: { fatFiles?: number } = {}): OnboardSample {
  const empty = emptyImport();
  const claude = opts.fatFiles ? tmp("fat-preview") : empty;
  const work = opts.fatFiles ? writeFatClaude(claude, opts.fatFiles) : 0;
  const importer = new Importer(tmp("ledger"), { claude, codex: empty, cursor: empty });
  const t0 = performance.now();
  const preview = importer.preview("claude");
  return {
    metric: "import_preview",
    ms: performance.now() - t0,
    ok: opts.fatFiles ? preview.sessions === opts.fatFiles : preview.sessions === 0,
    work: opts.fatFiles ? preview.sessions : 1,
    note: opts.fatFiles ? `fat ${opts.fatFiles} files ${work} lines` : "empty import root",
  };
}

export async function measureHubStart(opts: { fatFiles?: number } = {}): Promise<OnboardSample> {
  const claude = opts.fatFiles ? tmp("fat") : emptyImport();
  const work = opts.fatFiles ? writeFatClaude(claude, opts.fatFiles) : 0;
  const ready = await makeOnboardHub({ port: nextPort(), claude, start: false });
  try {
    const t0 = performance.now();
    await ready.hub.start();
    ready.hub.offerFirstImport();
    const ms = performance.now() - t0;
    const offered = ready.hub.lastImport?.sessions ?? 0;
    return {
      metric: "hub_start",
      ms,
      ok: opts.fatFiles ? offered >= opts.fatFiles : offered === 0,
      work: opts.fatFiles ? offered : 1,
      note: opts.fatFiles ? `fat ${opts.fatFiles} files ${work} lines` : "empty import roots",
    };
  } finally {
    ready.stop();
  }
}

export async function measureBunxReady(opts: { fatFiles?: number; claude?: string } = {}): Promise<OnboardSample> {
  const dataDir = tmp("bunx");
  const repo = await initTempRepo();
  const empty = emptyImport();
  const claude = opts.claude ?? (opts.fatFiles ? tmp("fat") : empty);
  const work = opts.fatFiles && !opts.claude ? writeFatClaude(claude, opts.fatFiles) : 0;
  const port = nextPort();
  const t0 = performance.now();
  const child = Bun.spawn([process.execPath, join(process.cwd(), "src/index.ts")], {
    cwd: repo,
    env: {
      ...process.env,
      NCLI_HARNESS: "mock",
      NCLI_GH: "mock",
      NCLI_DEMO: "0",
      NCLI_DATA: dataDir,
      NCLI_REPO: repo,
      NCLI_PORT: String(port),
      NCLI_HOST: "127.0.0.1",
      NCLI_IMPORT_CLAUDE: claude,
      NCLI_IMPORT_CODEX: empty,
      NCLI_IMPORT_CURSOR: empty,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitHttp(`http://127.0.0.1:${port}/`, 15000);
    const ms = performance.now() - t0;
    const html = await fetch(`http://127.0.0.1:${port}/`);
    const body = await html.text();
    return {
      metric: "bunx_ready",
      ms,
      ok: html.ok && body.includes('id="log"'),
      work: opts.fatFiles ? opts.fatFiles : 1,
      note: opts.fatFiles ? `fat ${opts.fatFiles} files ${work} lines` : "empty or fixture",
    };
  } finally {
    child.kill();
    await child.exited;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
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
    await Bun.sleep(20);
  }
  throw new Error(`server did not answer ${url}: ${last}`);
}

async function waitDom(session: CdpSession, expr: string, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await session.evaluate<boolean>(expr)) return true;
    await Bun.sleep(20);
  }
  return session.evaluate<boolean>(expr);
}

async function timeUntil(session: CdpSession, expr: string, ms: number): Promise<{ ms: number; ok: boolean }> {
  const t0 = performance.now();
  const ok = await waitDom(session, expr, ms);
  return { ms: performance.now() - t0, ok };
}

export async function measureOnboardChrome(opts: {
  screenshotDir?: string;
}): Promise<OnboardSample[]> {
  const ready = await makeOnboardHub({ port: nextPort(), claude: FIXTURE_CLAUDE, start: false });
  const booted = await bootNcli({ cfg: ready.hub.cfg, hub: ready.hub, root: process.cwd() });
  const driver = await launchChrome(9222 + Math.floor(Math.random() * 400));
  const shot = async (name: string) => {
    if (!opts.screenshotDir) return;
    mkdirSync(opts.screenshotDir, { recursive: true });
    writeFileSync(join(opts.screenshotDir, name), await driver.session.screenshot());
  };
  const samples: OnboardSample[] = [];
  try {
    await driver.session.attachPage("about:blank");
    const pathStart = performance.now();
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    const welcome = await timeUntil(
      driver.session,
      `Boolean(document.querySelector(".welcome") && document.getElementById("input"))`,
      8000,
    );
    samples.push({ metric: "welcome_paint", ms: welcome.ms, ok: welcome.ok, work: welcome.ok ? 1 : 0 });
    if (welcome.ok) await shot("01-welcome.png");

    const importReady = await timeUntil(
      driver.session,
      `(() => {
        const bar = document.getElementById("ibar");
        const go = document.querySelector("[data-welcome-import='claude']");
        return Boolean(go && bar && !bar.hidden && bar.querySelector("[data-import-apply]"));
      })()`,
      8000,
    );
    samples.push({
      metric: "import_ready",
      ms: importReady.ms,
      ok: importReady.ok,
      work: importReady.ok ? 1 : 0,
    });
    if (importReady.ok) await shot("02-import.png");

    const applyT0 = performance.now();
    await driver.session.evaluate(`document.querySelector("[data-welcome-import='claude']")?.click()`);
    const applyOk = await waitDom(
      driver.session,
      `Boolean(!document.querySelector(".welcome") && document.querySelectorAll("#log .u, #log .m").length > 0)`,
      8000,
    );
    samples.push({
      metric: "import_apply",
      ms: performance.now() - applyT0,
      ok: applyOk,
      work: applyOk ? 1 : 0,
    });
    if (applyOk) await shot("03-import-applied.png");

    const reply = await driver.session.evaluate<{ ms: number; ok: boolean }>(`(async () => {
      const input = document.getElementById("input");
      const form = document.getElementById("form");
      if (!input || !form) return { ms: 0, ok: false };
      input.focus();
      input.value = ${JSON.stringify(FIRST_Q)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const before = document.querySelectorAll("#log .u").length;
      const t0 = performance.now();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      const replied = () => {
        const users = [...document.querySelectorAll("#log .u")];
        if (users.length <= before) return false;
        let n = users.at(-1)?.nextElementSibling;
        while (n) {
          if (n.classList.contains("m") || n.classList.contains("live")) {
            const text = (n.querySelector(".md")?.textContent || "").trim();
            if (text && !/escrevendo a resposta/i.test(text)) return true;
          }
          n = n.nextElementSibling;
        }
        return false;
      };
      await new Promise((resolve) => {
        const done = () => {
          if (replied()) {
            obs.disconnect();
            resolve(true);
          }
        };
        const obs = new MutationObserver(done);
        obs.observe(document.getElementById("log"), { childList: true, subtree: true });
        done();
        setTimeout(() => { obs.disconnect(); resolve(false); }, 8000);
      });
      return { ms: performance.now() - t0, ok: replied() };
    })()`);
    samples.push({
      metric: "first_reply",
      ms: reply.ms,
      ok: reply.ok,
      work: reply.ok ? 1 : 0,
    });
    if (reply.ok) await shot("04-first-reply.png");

    const pr = await driver.session.evaluate<{ ms: number; ok: boolean }>(`(async () => {
      const input = document.getElementById("input");
      const form = document.getElementById("form");
      if (!input || !form) return { ms: 0, ok: false };
      input.focus();
      input.value = ${JSON.stringify(PR_URL)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const t0 = performance.now();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => {
        const done = () => {
          const overlay = document.getElementById("overlay");
          const modal = document.getElementById("modal");
          if (overlay && !overlay.hidden && (modal?.textContent || "").includes("482")) {
            obs.disconnect();
            resolve(true);
          }
        };
        const obs = new MutationObserver(done);
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        done();
        setTimeout(() => { obs.disconnect(); resolve(false); }, 12000);
      });
      const overlay = document.getElementById("overlay");
      const modal = document.getElementById("modal");
      return {
        ms: performance.now() - t0,
        ok: Boolean(overlay && !overlay.hidden && (modal?.textContent || "").includes("482")),
      };
    })()`);
    samples.push({ metric: "pr_open", ms: pr.ms, ok: pr.ok, work: pr.ok ? 1 : 0 });
    if (pr.ok) await shot("05-pr-open.png");

    const stageOk = samples.every((s) => s.ok);
    samples.push({
      metric: "onboard_total",
      ms: performance.now() - pathStart,
      ok: stageOk,
      work: samples.filter((s) => s.ok).length,
      note: "welcome → import → first reply → paste PR",
    });
    return samples;
  } finally {
    await driver.close();
    booted.stop();
  }
}

export function summarizeOnboard(metric: OnboardMetric, samples: OnboardSample[]): OnboardSummary {
  const mine = samples.filter((s) => s.metric === metric);
  const ok = mine.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  return {
    metric,
    n: mine.length,
    errors: mine.filter((s) => !s.ok).length,
    work: mine.reduce((n, s) => n + s.work, 0),
    p50: percentile(ok, 50),
    p95: percentile(ok, 95),
    min: ok[0] ?? 0,
    max: ok.at(-1) ?? 0,
  };
}

export async function runOnboard(opts: {
  runs?: number;
  chrome?: boolean;
  screenshotDir?: string;
  fatFiles?: number;
}): Promise<OnboardReport> {
  const runs = Math.max(1, opts.runs ?? 5);
  const useChrome = opts.chrome ?? Boolean(chromePath());
  const fatFiles = opts.fatFiles ?? 400;
  const samples: OnboardSample[] = [];
  for (let i = 0; i < runs; i++) {
    samples.push(measureImportPreview({}));
    samples.push(measureImportPreview({ fatFiles }));
    samples.push(await measureHubStart({}));
    samples.push(await measureHubStart({ fatFiles }));
    samples.push(await measureBunxReady({}));
    samples.push(await measureBunxReady({ fatFiles }));
  }
  if (useChrome) {
    for (let i = 0; i < runs; i++) {
      const shot = i === 0 ? opts.screenshotDir : undefined;
      samples.push(...(await measureOnboardChrome({ screenshotDir: shot })));
    }
  }
  return {
    at: new Date().toISOString(),
    runs,
    cores: cpus().length,
    load: loadavg().map((n) => n.toFixed(2)).join(" "),
    chrome: useChrome,
    metrics: ONBOARD_METRICS.map((id) => summarizeOnboard(id, samples)).filter((s) => s.n > 0),
    samples,
  };
}
