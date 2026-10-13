import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { persistSeatModel } from "../src/acp/session";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, shotsDir, waitUntil } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("queue chips expose send-now, edit and remove and the header is a seat picker", () => {
  expect(appJs).toContain("data-qnow");
  expect(appJs).toContain("enviar agora");
  expect(appJs).toContain("data-qedit");
  expect(appJs).toContain('body.mode = mode || "queue"');
  expect(appJs).toContain("Entra na fila ao fim do turno");
  expect(appJs).toContain("switch-copy");
  expect(appJs).toContain("id=\"switchBtn\"");
});

test("chrome: queued line appears above the input and the header lists three models", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub, dataDir } = await makeHub();
  persistSeatModel(dataDir, "main", "claude", "claude-opus-4-5");
  persistSeatModel(dataDir, "main", "codex", "gpt-5.4");
  persistSeatModel(dataDir, "main", "cursor", "composer-2.5");
  hub.cfg.port = 13200 + Math.floor(Math.random() * 400);
  const origRun = hub.harness.run.bind(hub.harness);
  hub.harness.run = async function* (opts) {
    await Bun.sleep(2200);
    yield* origRun(opts);
  };
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  const shots = shotsDir();
  mkdirSync(shots, { recursive: true });
  try {
    driver = await launchChrome(13300 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.getElementById("switchBtn"))`),
      8000,
      "header switcher",
    );

    await driver.session.evaluate(`(() => {
      const btn = document.getElementById("switchBtn");
      if (btn) btn.click();
    })()`);
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.querySelector(".switch-menu.open") && document.querySelectorAll("[data-harness]").length === 3)`),
      4000,
      "switch menu",
    );
    const menu = await driver.session.evaluate<{ labels: string[]; open: boolean }>(`(() => {
      const opts = [...document.querySelectorAll(".switch-opt")];
      return {
        open: Boolean(document.querySelector(".switch-menu.open")),
        labels: opts.map((el) => (el.textContent || "").replace(/\\s+/g, " ").trim()),
      };
    })()`);
    expect(menu.open).toBe(true);
    expect(menu.labels.some((l) => /Claude/i.test(l))).toBe(true);
    expect(menu.labels.some((l) => /Codex/i.test(l) && /GPT/i.test(l))).toBe(true);
    expect(menu.labels.some((l) => /Cursor/i.test(l))).toBe(true);
    writeFileSync(join(shots, "seat-switcher.png"), await driver.session.screenshot());
    await driver.session.evaluate(`document.getElementById("switchBtn")?.click()`);

    await driver.session.evaluate(`(() => {
      const input = document.getElementById("input");
      const form = document.getElementById("form");
      if (!input || !form) return;
      input.value = "primeiro";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    })()`);
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.querySelector(".live.quiet"))`),
      4000,
      "live turn",
    );
    await driver.session.evaluate(`(() => {
      const input = document.getElementById("input");
      const form = document.getElementById("form");
      if (!input || !form) return;
      input.value = "na fila";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    })()`);
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.querySelector(".qitem .qnow"))`),
      4000,
      "queue chip",
    );
    const chip = await driver.session.evaluate<{ text: string; now: string; edit: string }>(`(() => {
      const item = document.querySelector(".qitem");
      return {
        text: item?.querySelector("b")?.textContent || "",
        now: item?.querySelector(".qnow")?.textContent || "",
        edit: item?.querySelector(".qedit")?.textContent || "",
      };
    })()`);
    expect(chip.text).toContain("na fila");
    expect(chip.now).toBe("enviar agora");
    expect(chip.edit).toBe("editar");
    await Bun.sleep(200);
    writeFileSync(join(shots, "queue-chip.png"), await driver.session.screenshot());

    const before = hub.memory.log.map((m) => m.text);
    await driver.session.evaluate(`(() => {
      const btn = document.getElementById("switchBtn");
      if (btn) btn.click();
    })()`);
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.querySelector(".switch-menu.open"))`),
      3000,
      "reopen switcher",
    );
    await driver.session.evaluate(`document.querySelector('[data-harness="codex"]')?.click()`);
    await waitUntil(
      () => driver!.session.evaluate(`(document.querySelector(".switch-btn")?.innerText || "").includes("Codex")`),
      4000,
      "header Codex",
    );
    expect(hub.snapshot().main.harness).toBe("codex");
    expect(hub.memory.log.map((m) => m.text)).toEqual(before);
    writeFileSync(join(shots, "seat-codex.png"), await driver.session.screenshot());
  } finally {
    driver?.close();
    booted.stop();
  }
}, 30000);
