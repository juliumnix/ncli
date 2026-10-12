import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { makeHub, tmpDir, waitUntil } from "./helpers";

function writeFatClaude(root: string, files = 40, lines = 80): { files: number; lines: number } {
  const proj = join(root, "-home-julio-ncli");
  mkdirSync(proj, { recursive: true });
  const pad = "FACT_IMPORT_PAYLOAD ".repeat(12);
  for (let f = 0; f < files; f++) {
    const rows: string[] = [];
    for (let i = 0; i < lines; i++) {
      const sec = String((f * lines + i) % 60).padStart(2, "0");
      rows.push(JSON.stringify({
        type: i % 2 === 0 ? "user" : "assistant",
        timestamp: `2026-09-01T00:${String(f % 60).padStart(2, "0")}:${sec}.000Z`,
        cwd: "/Users/julio/ncli",
        message: { content: `${pad} ${f}:${i}` },
      }));
    }
    writeFileSync(join(proj, `sess-${String(f).padStart(3, "0")}.jsonl`), `${rows.join("\n")}\n`);
  }
  return { files, lines: files * lines };
}

test("first oi token arrives while a fat Claude import is still applying", async () => {
  const root = tmpDir("fat-claude-turn");
  const fat = writeFatClaude(root);
  expect(fat.lines).toBeGreaterThan(2000);
  const { hub, harness } = await makeHub({ importClaude: root });
  hub.cfg.port = 18800 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const url = booted.report.uiUrl;
  const rss0 = process.memoryUsage().rss;
  try {
    const t0 = Date.now();
    const apply = fetch(`${url}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "claude", apply: true }),
    });
    const applyRes = await apply;
    const applyMs = Date.now() - t0;
    expect(applyRes.ok).toBe(true);
    expect(await applyRes.json()).toMatchObject({ ok: true, started: true });
    expect(applyMs).toBeLessThan(500);
    const send = fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "oi" }),
    });
    await waitUntil(() => harness.lastPrompts.some((p) => /\boi\b/.test(p)), 8000, "first oi token");
    const ttft = Date.now() - t0;
    const rss = process.memoryUsage().rss;
    console.log(`import-turn ttft_ms=${ttft} apply_ms=${applyMs} rss_mb=${(rss / 1024 / 1024).toFixed(1)} delta_mb=${((rss - rss0) / 1024 / 1024).toFixed(1)} lines=${fat.lines}`);
    expect(ttft).toBeLessThan(3000);
    expect(await (await send).json()).toEqual({ ok: true, queue: [] });
    await waitUntil(() => hub.memory.log.some((m) => m.hops === "import:claude"), 15000, "import ingested");
  } finally {
    booted.stop();
  }
}, 20000);
