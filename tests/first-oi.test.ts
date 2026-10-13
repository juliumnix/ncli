import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { persistClaudeModel } from "../src/acp/claude";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, shotsDir, tmpDir, waitUntil } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("composer keystrokes skip layout and the live turn says Pensando immediately", () => {
  expect(appJs).toContain('if (!step) return "Pensando…"');
  expect(appJs).toContain("Sem resposta do Claude");
  expect(appJs).toContain("typeof window.__ncliComposerMeasures === \"number\"");
  expect(appJs).toContain("if (space === lastComposerSpace) return");
  expect(appJs).toContain("if (!value || !/github\\.com\\//i.test(value))");
  expect(appJs).toContain("}, 100);");
  expect(appJs).toContain("paintTick();");
});

test("chrome: Pensando and elapsed appear in under 100ms, header keeps the model, typing does not remeasure", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const dataDir = tmpDir("first-oi-ui");
  persistClaudeModel(dataDir, "main", "claude-opus-4-5");
  const { hub } = await makeHub({ dataDir });
  hub.cfg.port = 12800 + Math.floor(Math.random() * 400);
  hub.model = "claude-opus-4-5";
  const origRun = hub.harness.run.bind(hub.harness);
  hub.harness.run = async function* (opts) {
    await Bun.sleep(1800);
    yield* origRun(opts);
  };
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  const shots = shotsDir();
  mkdirSync(shots, { recursive: true });
  try {
    driver = await launchChrome(12900 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver!.session.evaluate(`(document.querySelector(".seat-label")?.innerText || document.querySelector(".switch-btn")?.innerText || "").includes("Opus")`),
      8000,
      "header model",
    );
    const header = await driver.session.evaluate<string>(`document.querySelector(".seat-label")?.innerText || document.querySelector(".switch-btn")?.innerText || ""`);
    expect(header).toContain("Opus");

    const typeFacts = await driver.session.evaluate<{ before: number; after: number }>(`(() => {
      const input = document.getElementById("input");
      if (!input) return { before: -1, after: -1 };
      window.__ncliComposerMeasures = 0;
      input.focus();
      for (const ch of "ola isso e um teste de digitacao sem jank xx") {
        input.value += ch;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return { before: 0, after: window.__ncliComposerMeasures };
    })()`);
    expect(typeFacts.after).toBe(typeFacts.before);

    const think = await driver.session.evaluate<{ ms: number; phrase: string; elapsed: string }>(`(async () => {
      const input = document.getElementById("input");
      const form = document.getElementById("form");
      if (!input || !form) return { ms: -1, phrase: "", elapsed: "" };
      input.value = "oi";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const t0 = performance.now();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      const live = () => document.querySelector(".live.quiet");
      if (!live()) {
        await new Promise((resolve) => {
          const obs = new MutationObserver(() => { if (live()) { obs.disconnect(); resolve(true); } });
          obs.observe(document.getElementById("log"), { childList: true, subtree: true });
          setTimeout(() => { obs.disconnect(); resolve(false); }, 1000);
        });
      }
      const node = live();
      return {
        ms: performance.now() - t0,
        phrase: node?.querySelector(".shimmer-text")?.textContent || "",
        elapsed: node?.querySelector(".tdur")?.textContent || "",
      };
    })()`);
    expect(think.ms).toBeGreaterThanOrEqual(0);
    expect(think.ms).toBeLessThan(100);
    expect(think.phrase).toBe("Pensando…");
    expect(think.elapsed).toMatch(/^\d+\.\d+s$/);
    await Bun.sleep(250);
    const still = await driver.session.evaluate<{ phrase: string; elapsed: string; header: string }>(`({
      phrase: document.querySelector(".live.quiet .shimmer-text")?.textContent || "",
      elapsed: document.querySelector(".live.quiet .tdur")?.textContent || "",
      header: document.querySelector(".seat-label")?.innerText || "",
    })`);
    expect(still.phrase).toBe("Pensando…");
    expect(still.header).toContain("Opus");
    writeFileSync(join(shots, "first-oi-thinking.png"), await driver.session.screenshot());
    writeFileSync(join(shots, "first-oi-header.png"), await driver.session.screenshot());

    const trace = {
      before: {
        composerMeasuresPerKey: 1,
        note: "renderPasteHint called measureComposer (getBoundingClientRect) on every input",
      },
      after: {
        composerMeasuresPerKey: typeFacts.after - typeFacts.before,
        thinkMs: think.ms,
        thinkPhrase: think.phrase,
        header: header,
        note: "github-only paste hint; measureComposer skips unchanged height; 100ms elapsed tick",
      },
    };
    writeFileSync(join(shots, "first-oi-perf.json"), JSON.stringify(trace, null, 2));
  } finally {
    driver?.close();
    booted.stop();
  }
}, 30000);
