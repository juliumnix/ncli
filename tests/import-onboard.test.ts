import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub } from "./helpers";

const CLAUDE = join(import.meta.dir, "../fixtures/import/claude/projects");
const SHOTS = "/opt/cursor/artifacts/screenshots";

test("chrome: empty session shows welcome and the claude import bar", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub({ importClaude: CLAUDE });
  hub.cfg.port = 18400 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(9600 + Math.floor(Math.random() * 400));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await driver.session.evaluate(`new Promise((resolve) => {
      const ready = () => {
        const bar = document.getElementById("ibar");
        return Boolean(document.querySelector(".welcome") && bar && !bar.hidden && bar.querySelector("[data-import-apply]"));
      };
      if (ready()) return resolve(true);
      const obs = new MutationObserver(() => { if (ready()) { obs.disconnect(); resolve(true); } });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => resolve(Boolean(ready())), 6000);
    })`);
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
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(`${SHOTS}/import-onboard.png`, await driver.session.screenshot());
  } finally {
    driver.close();
    booted.stop();
  }
}, 30000);
