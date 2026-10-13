import { expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { defaultImportRoots, IMPORT_BATCH_BYTES, IMPORT_BATCH_LINES, runImportJob } from "../src/import";
import { makeHub, tmpDir, waitUntil } from "./helpers";

function writeOneFatFile(root: string, lines = 6000, padN = 600): number {
  const proj = join(root, "workspace");
  mkdirSync(proj, { recursive: true });
  const pad = "W".repeat(padN);
  const rows: string[] = [];
  for (let i = 0; i < lines; i++) {
    rows.push(JSON.stringify({
      type: i % 2 === 0 ? "user" : "assistant",
      timestamp: `2026-08-01T00:00:00.${String(i % 1000).padStart(3, "0")}Z`,
      cwd: "/workspace",
      message: { content: [{ type: "text", text: `${pad} ${i}` }] },
    }));
  }
  writeFileSync(join(proj, "sess-fat.jsonl"), `${rows.join("\n")}\n`);
  return lines;
}

async function loopLagMs(): Promise<number> {
  const t0 = performance.now();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return performance.now() - t0;
}

test("a fat import keeps the main event loop under 40ms and names the worker", async () => {
  const root = tmpDir("fat-loop");
  const lines = writeOneFatFile(root);
  const { hub, harness } = await makeHub({ importClaude: root });
  hub.cfg.port = 18600 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const url = booted.report.uiUrl;
  const lags: number[] = [];
  let sampling = true;
  const sample = (async () => {
    while (sampling) {
      lags.push(await loopLagMs());
      await Bun.sleep(8);
    }
  })();
  await Bun.sleep(40);
  try {
    const rss0 = process.memoryUsage().rss;
    const t0 = Date.now();
    const apply = await fetch(`${url}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "claude", apply: true }),
    });
    expect(await apply.json()).toMatchObject({ ok: true, started: true, via: "worker" });
    const send = fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "oi" }),
    });
    await waitUntil(() => harness.lastPrompts.some((p) => /\boi\b/.test(p)), 8000, "oi");
    const ttft = Date.now() - t0;
    await waitUntil(() => hub.memory.log.some((m) => m.hops === "import:claude"), 20000, "ingest");
    sampling = false;
    await sample;
    const rss = process.memoryUsage().rss;
    const worst = Math.max(...lags, 0);
    const p95 = lags.slice().sort((a, b) => a - b)[Math.floor(lags.length * 0.95)] ?? 0;
    console.log(`import-worker ttft_ms=${ttft} loop_p95_ms=${p95.toFixed(1)} loop_max_ms=${worst.toFixed(1)} rss_mb=${(rss / 1024 / 1024).toFixed(1)} delta_mb=${((rss - rss0) / 1024 / 1024).toFixed(1)} lines=${lines} samples=${lags.length}`);
    expect(ttft).toBeLessThan(3000);
    expect(p95).toBeLessThan(50);
    expect(rss - rss0).toBeLessThan(180 * 1024 * 1024);
    expect(rss).toBeLessThan(500 * 1024 * 1024);
    expect(await (await send).json()).toEqual({ ok: true, queue: [] });
  } finally {
    sampling = false;
    booted.stop();
  }
}, 25000);

function writeHugeClaude(root: string, files = 24, lines = 1600, padN = 220): { files: number; bytes: number } {
  const proj = join(root, "workspace");
  mkdirSync(proj, { recursive: true });
  const pad = "H".repeat(padN);
  let bytes = 0;
  for (let f = 0; f < files; f++) {
    const rows: string[] = [];
    for (let i = 0; i < lines; i++) {
      rows.push(JSON.stringify({
        type: i % 2 === 0 ? "user" : "assistant",
        timestamp: `2026-07-01T${String(f % 24).padStart(2, "0")}:00:00.${String(i % 1000).padStart(3, "0")}Z`,
        cwd: "/workspace",
        message: { content: [{ type: "text", text: `${pad} ${f}:${i}` }] },
      }));
    }
    const path = join(proj, `sess-${String(f).padStart(3, "0")}.jsonl`);
    writeFileSync(path, `${rows.join("\n")}\n`);
    bytes += statSync(path).size;
  }
  return { files, bytes };
}

test("worker batches stay under the line and byte caps", async () => {
  expect(IMPORT_BATCH_LINES).toBe(32);
  expect(IMPORT_BATCH_BYTES).toBe(256 * 1024);
  const root = tmpDir("batch-cap");
  writeHugeClaude(root, 6, 400, 180);
  const sizes: number[] = [];
  const counts: number[] = [];
  await runImportJob({
    source: "claude",
    roots: { ...defaultImportRoots(), claude: root },
    seenFile: join(tmpDir("batch-seen"), "import-seen.json"),
    onBatch: (lines) => {
      counts.push(lines.length);
      sizes.push(Buffer.byteLength(JSON.stringify(lines)));
    },
  });
  expect(counts.length).toBeGreaterThan(4);
  expect(Math.max(...counts)).toBeLessThanOrEqual(IMPORT_BATCH_LINES);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(IMPORT_BATCH_BYTES + 32 * 1024);
});

test("a large on-disk history keeps the main process under 500MB RSS", async () => {
  const root = tmpDir("rss-cap");
  const fat = writeHugeClaude(root, 18, 900, 280);
  expect(fat.bytes).toBeGreaterThan(5 * 1024 * 1024);
  const child = Bun.spawn({
    cmd: ["bun", join(import.meta.dir, "import-rss-child.ts"), root],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(child.stdout).text();
  const err = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`rss child exit ${code}\n${err}\n${out}`);
  const line = out.trim().split("\n").at(-1) ?? "";
  const report = JSON.parse(line) as { rss: number; previewLines: number; applied: number; filesScanned: number };
  console.log(`import-rss rss_mb=${(report.rss / 1024 / 1024).toFixed(1)} disk_mb=${(fat.bytes / 1024 / 1024).toFixed(1)} applied=${report.applied} files=${fat.files} stderr=${/error/i.test(err) ? "err" : "ok"}`);
  expect(report.applied).toBeGreaterThan(1000);
  expect(report.filesScanned).toBe(fat.files);
  expect(report.previewLines).toBe(0);
  expect(report.rss).toBeLessThan(500 * 1024 * 1024);
}, 90000);
