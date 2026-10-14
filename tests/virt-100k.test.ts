import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { LogIndex } from "../src/memory/log-index";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, shotsDir, tmpDir, waitUntil } from "./helpers";

function p95(values: number[]): number {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, i)] ?? Number.POSITIVE_INFINITY;
}

function writeLife(dir: string, n = 100_000) {
  mkdirSync(dir, { recursive: true });
  const lines = new Array(n);
  for (let i = 0; i < n; i++) {
    lines[i] = JSON.stringify({
      i,
      kind: i % 3 === 0 ? "user" : "talk",
      text: i === 0 ? "PRIMEIRA mensagem da vida" : `linha ${i} **md**`,
      size: 24,
      date: `2020-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    });
  }
  writeFileSync(join(dir, "log.jsonl"), `${lines.join("\n")}\n`);
}

test("chrome: 100k virtual list opens, jumps to first, and stays at 60fps", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const dataDir = tmpDir("virt-100k");
  const main = join(dataDir, "main");
  writeLife(main, 100_000);
  const idx = new LogIndex(main);
  idx.rebuildSync();
  const { hub } = await makeHub({ dataDir });
  expect(hub.memory.log.length).toBe(0);
  expect(hub.memory.logIndex.count).toBe(100_000);
  hub.cfg.port = 0;
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: join(import.meta.dir, "..") });
  const driver = await launchChrome(23000 + (Date.now() % 10000), [
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
  ]);
  const shots = shotsDir();
  mkdirSync(shots, { recursive: true });
  try {
    const tNav = Date.now();
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`document.querySelectorAll("#log [data-mid]").length > 0`),
      15000,
      "first paint",
    );
    const openMs = Date.now() - tNav;
    const boot = await driver.session.evaluate<{ nodes: number; count: number }>(`({
      nodes: document.querySelectorAll("#log [data-mid]").length,
      count: window.__NCLI_VIRT ? 0 : document.querySelectorAll("#log [data-mid]").length,
    })`);
    const facts = await driver.session.evaluate<{
      nodes: number;
      count: number;
      first: string;
    }>(`({
      nodes: document.querySelectorAll("#log [data-mid]").length,
      count: document.querySelector("#hist") && !document.querySelector("#hist").hidden ? 1 : 0,
      first: document.querySelector("#log [data-mid]")?.textContent || "",
    })`);

    const input = await driver.session.evaluate<{ samples: number[] }>(`(async () => {
      const el = document.getElementById("input");
      if (!el) return { samples: [] };
      el.focus();
      const samples = [];
      for (const ch of "digitando 100k xx") {
        const t0 = performance.now();
        el.value += ch;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        await new Promise((r) => requestAnimationFrame(r));
        samples.push(performance.now() - t0);
      }
      return { samples };
    })()`);

    const fps = await driver.session.evaluate<{ frames: number[]; nodes: number }>(`(async () => {
      const chat = document.getElementById("chat");
      const frames = [];
      let last = performance.now();
      const start = chat.scrollTop;
      for (let k = 0; k < 40; k++) {
        chat.scrollTop = Math.max(0, start - k * 180);
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        frames.push(now - last);
        last = now;
      }
      return { frames, nodes: document.querySelectorAll("#log [data-mid]").length };
    })()`);

    const jump = await driver.session.evaluate<{ ms: number; text: string; nodes: number }>(`(async () => {
      const t0 = performance.now();
      document.getElementById("histStart")?.click();
      for (let i = 0; i < 80; i++) {
        const t = document.querySelector("#log [data-mid]")?.textContent || "";
        if (/PRIMEIRA/.test(t) || /linha 0/.test(t)) {
          return { ms: performance.now() - t0, text: t, nodes: document.querySelectorAll("#log [data-mid]").length };
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      return {
        ms: performance.now() - t0,
        text: document.querySelector("#log [data-mid]")?.textContent || "",
        nodes: document.querySelectorAll("#log [data-mid]").length,
      };
    })()`);

    const payload = {
      openMs,
      bootNodes: facts.nodes,
      inputP95: p95(input.samples),
      frameP95: p95(fps.frames),
      scrollNodes: fps.nodes,
      jumpMs: jump.ms,
      jumpText: jump.text,
      jumpNodes: jump.nodes,
    };
    writeFileSync(join(shots, `virt-100k-${Date.now()}.json`), JSON.stringify(payload, null, 2));
    expect(openMs).toBeLessThan(300);
    expect(facts.nodes).toBeLessThan(80);
    expect(p95(input.samples)).toBeLessThan(16);
    expect(p95(fps.frames)).toBeLessThan(20);
    expect(fps.nodes).toBeLessThan(80);
    expect(jump.ms).toBeLessThan(500);
    expect(jump.text).toMatch(/PRIMEIRA|linha 0/);
    expect(jump.nodes).toBeLessThan(80);
    void boot;
  } finally {
    driver.close();
    booted.stop();
    hub.close();
  }
}, 90000);
