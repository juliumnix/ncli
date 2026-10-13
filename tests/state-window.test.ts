import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { STATE_PAGE } from "../src/state-page";
import { makeHub, shotsDir, waitUntil } from "./helpers";

function p95(values: number[]): number {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, i)] ?? Number.POSITIVE_INFINITY;
}

function seedFat(hub: Awaited<ReturnType<typeof makeHub>>["hub"], n = 6600) {
  hub.memory.ingest(
    Array.from({ length: n }, (_, i) => ({
      kind: (i % 3 === 0 ? "user" : "talk") as "user" | "talk",
      text: `linha ${i} com **markdown** e um pouco de texto`,
    })),
  );
}

test("chrome: 6600-message window meets payload and paint budgets", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  seedFat(hub);
  const rt = await hub.sparks.open("review", { pr: "482" });
  hub.cfg.port = 0;
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: join(import.meta.dir, "..") });
  const driver = await launchChrome(22000 + (Date.now() % 12000), [
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
  ]);
  const shots = shotsDir();
  mkdirSync(shots, { recursive: true });
  try {
    const res = await fetch(`${booted.report.uiUrl}/api/state`);
    const buf = Buffer.from(await res.arrayBuffer());
    const snap = JSON.parse(buf.toString("utf8")) as {
      messages: unknown[];
      messageCount: number;
      forks?: unknown;
      waiting?: unknown;
    };
    expect(snap.messageCount).toBe(6600);
    expect(snap.messages.length).toBeLessThanOrEqual(STATE_PAGE);
    expect(snap.forks).toBeUndefined();
    expect(snap.waiting).toBeUndefined();
    expect(buf.byteLength).toBeLessThan(200 * 1024);

    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`document.querySelectorAll("#log [data-mid]").length > 10`),
      15000,
      "windowed chat",
    );
    const dom = await driver.session.evaluate<{ nodes: number; last: string }>(`({
      nodes: document.querySelectorAll("#log [data-mid]").length,
      last: document.querySelector("#log .u:last-of-type, #log .m:last-of-type")?.textContent || "",
    })`);
    expect(dom.nodes).toBeLessThanOrEqual(STATE_PAGE + 8);
    expect(dom.last).toContain("6599");

    async function measureInput() {
      return driver.session.evaluate<{ samples: number[]; value: string }>(`(async () => {
        const el = document.getElementById("input");
        if (!el) return { samples: [], value: "" };
        el.focus();
        el.value = "";
        const samples = [];
        const typed = "digitando no log de 6600 xx";
        for (const ch of typed) {
          const t0 = performance.now();
          el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
          el.value += ch;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
          await new Promise((r) => requestAnimationFrame(r));
          samples.push(performance.now() - t0);
        }
        return { samples, value: el.value };
      })()`);
    }
    let input = await measureInput();
    let inputP95 = p95(input.samples);
    if (inputP95 >= 16) {
      input = await measureInput();
      inputP95 = p95(input.samples);
    }

    await driver.session.evaluate(`document.querySelector('[data-spark="${rt.spark.id}"]')?.click()`);
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.querySelector(".rv-rev"))`),
      8000,
      "reviewed button",
    );
    const reviewed = await driver.session.evaluate<{ ms: number; on: boolean }>(`(() => {
      const btn = document.querySelector(".rv-rev");
      if (!btn) return { ms: 999, on: false };
      const t0 = performance.now();
      btn.click();
      return { ms: performance.now() - t0, on: btn.classList.contains("on") };
    })()`);

    const echo = await driver.session.evaluate<{ ms: number; text: string }>(`(async () => {
      const form = document.getElementById("form");
      const el = document.getElementById("input");
      if (!form || !el) return { ms: 999, text: "" };
      el.value = "eco agora";
      const t0 = performance.now();
      form.requestSubmit();
      await new Promise((r) => requestAnimationFrame(r));
      const node = [...document.querySelectorAll("#log .u")].at(-1);
      return { ms: performance.now() - t0, text: node ? node.textContent || "" : "" };
    })()`);

    const payload = {
      bytes: buf.byteLength,
      dom: dom.nodes,
      inputP95,
      reviewedMs: reviewed.ms,
      echoMs: echo.ms,
      reviewedOn: reviewed.on,
      echoText: echo.text,
    };
    writeFileSync(join(shots, `state-window-${Date.now()}.json`), JSON.stringify(payload, null, 2));
    expect(inputP95).toBeLessThan(16);
    expect(reviewed.on).toBe(true);
    expect(reviewed.ms).toBeLessThan(50);
    expect(echo.text).toContain("eco agora");
    expect(echo.ms).toBeLessThan(50);
  } finally {
    driver.close();
    booted.stop();
    hub.close();
  }
}, 60000);
