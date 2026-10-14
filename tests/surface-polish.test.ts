import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mermaidSvg } from "../src/live/frame";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, shotsDir, waitUntil } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");

test("Esc closes switch, then overlay, then drawer", () => {
  const esc = appJs.indexOf('if (e.key !== "Escape") return;');
  expect(esc).toBeGreaterThan(0);
  const slice = appJs.slice(esc, esc + 420);
  expect(slice.indexOf("state.switchOpen")).toBeLessThan(slice.indexOf("overlay.classList.contains"));
  expect(slice.indexOf("overlay.classList.contains")).toBeLessThan(slice.indexOf("drawer-open"));
});

test("chrome key ignores the open flag and welcome import is secondary", () => {
  expect(appJs).toContain("${seat}|${main.model || \"\"}|${limited ? 1 : 0}|${opts}");
  expect(appJs).toContain("lendo ${p.done || 0} de ${p.total || 1}");
  expect(appJs).toContain("if (chromeNow().showWelcome)");
  expect(appCss).toContain(".welcome-go {");
  expect(appCss).toContain("background: var(--surface)");
  expect(appCss).toContain(".log.from-welcome > *");
  expect(appCss).toContain(".live-wrap, .ui-card");
  expect(appCss).toContain("backdrop-filter: none");
});

test("mermaid nodes sit 16px inside the SVG", () => {
  const svg = mermaidSvg("graph TD\nA[total] --> B[ok]");
  expect(svg).toContain('x="16"');
  expect(svg).toContain('y="28"');
  expect(svg).toMatch(/viewBox="0 0 \d+ 112"/);
});

test("chrome: welcome import is secondary and ibar stays hidden", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  hub.cfg.port = 19700 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    driver = await launchChrome(10250 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.querySelector(".welcome"))`),
      8000,
      "welcome",
    );
    const facts = await driver.session.evaluate<{
      ibarHidden: boolean;
      headerAvatars: number;
      usesAccent: boolean;
    }>(`(() => {
      const go = document.querySelector(".welcome-go");
      const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim();
      const bg = go ? getComputedStyle(go).backgroundColor : "";
      return {
        ibarHidden: Boolean(document.getElementById("ibar")?.hidden),
        headerAvatars: document.querySelectorAll("#switchBtn .av").length,
        usesAccent: Boolean(go && accent && bg && bg === getComputedStyle(document.body).getPropertyValue("--accent")),
      };
    })()`);
    expect(facts.ibarHidden).toBe(true);
    expect(facts.headerAvatars).toBe(1);
    expect(facts.usesAccent).toBe(false);
    const dir = shotsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "surface-welcome.png"), await driver.session.screenshot());
  } finally {
    driver?.close();
    booted.stop();
    hub.close();
  }
}, 30000);
