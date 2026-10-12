import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, shotsDir, waitUntil } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const CLAUDE = join(import.meta.dir, "../fixtures/import/claude/projects");
const SHOTS = shotsDir();

test("empty hub offers the richest CLI history and welcome has one-click import", async () => {
  expect(appJs).toContain("data-welcome-import");
  expect(appJs).toContain("trazer Claude");
  const { hub } = await makeHub({ importClaude: CLAUDE });
  try {
    expect(hub.lastImport?.source).toBe("claude");
    expect(hub.lastImport?.sessions).toBeGreaterThan(0);
  } finally {
    hub.close();
  }
});

test("chrome: empty session shows welcome and the claude import bar", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub({ importClaude: CLAUDE });
  hub.cfg.port = 18400 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(9600 + Math.floor(Math.random() * 400));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`(() => {
        const bar = document.getElementById("ibar");
        return Boolean(document.querySelector(".welcome") && bar && !bar.hidden && bar.querySelector("[data-import-apply]"));
      })()`),
      8000,
      "welcome and import bar",
    );
    const facts = await driver.session.evaluate<{
      welcome: string;
      barHidden: boolean;
      barText: string;
      apply: string | null;
    }>(`(() => {
      const bar = document.getElementById("ibar");
      const apply = bar?.querySelector("[data-import-apply]");
      return {
        welcome: document.querySelector(".welcome")?.textContent?.trim() || "",
        barHidden: Boolean(bar?.hidden),
        barText: bar?.textContent?.trim() || "",
        apply: apply ? apply.getAttribute("data-import-apply") : null,
      };
    })()`);
    expect(facts.welcome).toContain("O mesmo Claude do CLI");
    expect(facts.barHidden).toBe(false);
    expect(facts.barText).toContain("claude");
    expect(facts.barText).toContain("4 novas");
    expect(facts.apply).toBe("claude");
    const go = await driver.session.evaluate<number>(
      `document.querySelectorAll("[data-welcome-import]").length`,
    );
    expect(go).toBe(3);
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(`${SHOTS}/import-onboard.png`, await driver.session.screenshot());
  } finally {
    driver.close();
    booted.stop();
  }
}, 30000);
