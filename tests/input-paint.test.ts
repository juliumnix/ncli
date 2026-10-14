import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, shotsDir, tmpDir, waitUntil } from "./helpers";

function writeFatClaude(root: string, files = 24, lines = 20): void {
  const proj = join(root, "workspace");
  mkdirSync(proj, { recursive: true });
  for (let f = 0; f < files; f++) {
    const rows = Array.from({ length: lines }, (_, i) => JSON.stringify({
      type: "user",
      timestamp: `2026-10-12T0${f % 10}:00:${String(i).padStart(2, "0")}.000Z`,
      cwd: "/workspace",
      message: { content: `FACT_LINE_${f}_${i} **md** ${"palavra ".repeat(12)}` },
    }));
    writeFileSync(join(proj, `sess-${String(f).padStart(3, "0")}.jsonl`), `${rows.join("\n")}\n`);
  }
}

function p95(values: number[]): number {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, i)] ?? Number.POSITIVE_INFINITY;
}

test("chrome: p95 input-to-paint stays under 16ms while import and stream run", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const importRoot = tmpDir("paint-import");
  writeFatClaude(importRoot);
  const { hub } = await makeHub({ importClaude: importRoot });
  for (let i = 0; i < 1800; i++) {
    hub.memory.append({
      kind: i % 3 === 0 ? "user" : "talk",
      text: `linha ${i} com **markdown** e um pouco de texto ${"x".repeat(40)}`,
    });
  }
  const origRun = hub.harness.run.bind(hub.harness);
  hub.harness.run = async function* (opts) {
    yield { type: "model", model: "mock" };
    for (const piece of ["pensando ", "sobre ", "o histórico ", "enquanto você digita "]) {
      yield { type: "text", text: piece, seat: "claude" };
      await Bun.sleep(40);
    }
    yield* origRun(opts);
  };
  hub.cfg.port = 16800 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(13900 + Math.floor(Math.random() * 400), [
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
  ]);
  const shots = shotsDir();
  mkdirSync(shots, { recursive: true });
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`document.querySelectorAll("#log [data-mid]").length > 10`),
      12000,
      "seeded chat",
    );
    void hub.applyImport("claude");
    void hub.send("continua o texto longo enquanto o import corre");
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.getElementById("jobInd") && !document.getElementById("jobInd").hidden)`),
      8000,
      "import job",
    );
    const measured = await driver.session.evaluate<{ samples: number[]; value: string }>(`(async () => {
      const input = document.getElementById("input");
      if (!input) return { samples: [], value: "" };
      input.focus();
      const samples = [];
      const typed = "digitando no meio do import xx";
      for (const ch of typed) {
        const t0 = performance.now();
        input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
        input.value += ch;
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        await new Promise((r) => requestAnimationFrame(r));
        samples.push(performance.now() - t0);
      }
      return { samples, value: input.value };
    })()`);
    const payload = { samples: measured.samples, p95: p95(measured.samples), n: measured.samples.length };
    writeFileSync(join(shots, `input-paint-${Date.now()}.json`), JSON.stringify(payload, null, 2));
    expect(p95(measured.samples)).toBeLessThan(16);
    expect(measured.value.length).toBeGreaterThan(8);
  } finally {
    driver.close();
    booted.stop();
    hub.close();
  }
});
