import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, shotsDir, tmpDir, waitUntil } from "./helpers";

function writeFatClaude(root: string, files = 16, lines = 12): void {
  const proj = join(root, "workspace");
  mkdirSync(proj, { recursive: true });
  for (let f = 0; f < files; f++) {
    const rows = Array.from({ length: lines }, (_, i) => JSON.stringify({
      type: "user",
      timestamp: `2026-10-12T0${f % 10}:00:${String(i).padStart(2, "0")}.000Z`,
      cwd: "/workspace",
      message: { content: `FACT_LINE_${f}_${i}` },
    }));
    writeFileSync(join(proj, `sess-${String(f).padStart(3, "0")}.jsonl`), `${rows.join("\n")}\n`);
  }
}

test("hub compact status carries done/total instead of a cryptic node count", async () => {
  const { hub } = await makeHub();
  try {
    expect(hub.compact.done).toBe(0);
    expect(hub.compact.total).toBe(0);
    hub.publishCompact({
      running: true,
      lastNodes: 3,
      done: 12,
      total: 28,
      tokensToday: 4000,
      budget: 250000,
      model: "composer-2.5",
    });
    expect(hub.compact.done).toBe(12);
    expect(hub.compact.total).toBe(28);
    expect(hub.compact.lastNodes).toBe(3);
  } finally {
    hub.close();
  }
});

test("chrome: job rail names the import stage and advances the bar", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const root = tmpDir("job-ui");
  writeFatClaude(root, 20, 16);
  const { hub } = await makeHub({ importClaude: root });
  hub.cfg.port = 19100 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(12200 + Math.floor(Math.random() * 400));
  const shots = shotsDir();
  mkdirSync(shots, { recursive: true });
  const frames: string[] = [];
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.querySelector("[data-welcome-import='claude']"))`),
      8000,
      "welcome chip",
    );
    await driver.session.evaluate(`document.querySelector("[data-welcome-import='claude']")?.click()`);
    await waitUntil(
      () => driver.session.evaluate(`(() => {
        const el = document.getElementById("jobInd");
        return Boolean(el && !el.hidden && /Lendo seu histórico do Claude/.test(el.innerText || ""));
      })()`),
      8000,
      "import job rail",
    );
    const seen: string[] = [];
    const until = Date.now() + 2500;
    while (Date.now() < until) {
      const snap = await driver.session.evaluate<{ text: string; pct: string; phase: string }>(`(() => {
        const el = document.getElementById("jobInd");
        return {
          text: el?.innerText || "",
          pct: el?.style.getPropertyValue("--job-pct") || "",
          phase: el?.dataset.phase || "",
        };
      })()`);
      if (snap.text && !seen.includes(snap.text)) {
        seen.push(snap.text);
        const name = `job-import-${seen.length}.png`;
        writeFileSync(join(shots, name), await driver.session.screenshot());
        frames.push(name);
      }
      if (seen.length >= 3) break;
      await Bun.sleep(80);
    }
    writeFileSync(join(shots, "job-import.png"), await driver.session.screenshot());
    expect(seen.some((t) => /Lendo seu histórico do Claude/.test(t))).toBe(true);
    expect(seen.join("\n")).not.toMatch(/compactando/);
    expect(seen.join("\n")).not.toMatch(/trazendo…/);
    await waitUntil(() => hub.lastImport?.newCount === 0, 15000, "import applied");
    await Bun.sleep(1600);

    hub.publishCompact({
      running: true,
      lastNodes: 3,
      done: 12,
      total: 28,
      tokensToday: 4000,
      budget: 250000,
      model: "composer-2.5",
    });
    await waitUntil(
      () => driver.session.evaluate(`(() => {
        const el = document.getElementById("jobInd");
        return Boolean(el && !el.hidden && /Organizando a memória/.test(el.innerText || "") && /42%/.test(el.innerText || ""));
      })()`),
      4000,
      "compact job rail",
    );
    writeFileSync(join(shots, "job-compact.png"), await driver.session.screenshot());
    frames.push("job-compact.png");

    hub.publishCompact({
      running: false,
      lastNodes: 3,
      done: 28,
      total: 28,
      tokensToday: 4000,
      budget: 250000,
      model: "composer-2.5",
    });
    await waitUntil(
      () => driver.session.evaluate(`(() => {
        const el = document.getElementById("jobInd");
        return Boolean(el && /Memória organizada/.test(el.innerText || "") && el.classList.contains("is-out"));
      })()`),
      4000,
      "compact done fade",
    );
    writeFileSync(join(shots, "job-done.png"), await driver.session.screenshot());
    frames.push("job-done.png");

    hub.publishCompact({
      running: false,
      lastNodes: 0,
      done: 4,
      total: 28,
      tokensToday: 4000,
      budget: 250000,
      model: "composer-2.5",
      error: "timeout",
    });
    await waitUntil(
      () => driver.session.evaluate(`(() => {
        const el = document.getElementById("jobInd");
        return Boolean(el && /Não deu pra organizar a memória/.test(el.innerText || "") && el.querySelector("[data-job-retry='compact']"));
      })()`),
      4000,
      "compact error retry",
    );
    writeFileSync(join(shots, "job-error.png"), await driver.session.screenshot());
    frames.push("job-error.png");
    console.log(`job-ui labels=${JSON.stringify(seen)} frames=${frames.length}`);
  } finally {
    driver.close();
    booted.stop();
  }
}, 70000);
