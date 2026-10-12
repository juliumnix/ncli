import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
const SHOTS = "/opt/cursor/artifacts/screenshots";

test("app.js paints recall chips and highlights the drawer row", () => {
  expect(appJs).toContain("function recallChipHtml");
  expect(appJs).toContain("function openRecallCite");
  expect(appJs).toContain("citeId");
  expect(appJs).toContain("verificado");
  expect(appJs).toContain("substituído");
  expect(appJs).toContain("sem zoom");
  expect(appCss).toContain(".recall-chip.verified");
  expect(appCss).toContain(".recall-chip.superseded");
  expect(appCss).toContain(".ctx-row.cite");
  expect(appCss).toContain("var(--success-bg)");
  expect(appCss).toContain("var(--warning-bg)");
  expect(appCss).toContain("var(--accent-bg)");
});

test("chrome: chips sit under the talk and a click highlights the drawer row", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  hub.memory.append({ kind: "user", text: "the rate is 10" });
  hub.memory.append({ kind: "user", text: "the rate is 15" });
  hub.memory.append({
    kind: "talk",
    text: "The rate is 15 percent [#1]. The old ten [#0] is gone. I also guessed [#12].",
    seat: "claude",
    recall: [
      { id: 1, status: "verified" },
      { id: 0, status: "superseded" },
      { id: 12, status: "unverified" },
    ],
  });
  hub.cfg.port = 18300 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(9500 + Math.floor(Math.random() * 400));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitChips(driver);
    const before = await driver.session.evaluate<{
      chips: string[];
      drawerOpen: boolean;
    }>(`(() => ({
      chips: [...document.querySelectorAll(".recall-chip")].map((el) => el.textContent.trim()),
      drawerOpen: document.body.classList.contains("drawer-open"),
    }))()`);
    expect(before.chips).toEqual(["#1 verificado", "#0 substituído", "#12 sem zoom"]);
    expect(before.drawerOpen).toBe(false);
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(`${SHOTS}/recall-chips.png`, await driver.session.screenshot());

    await driver.session.evaluate(`document.querySelector(".recall-chip.verified").click()`);
    const after = await driver.session.evaluate<{
      drawerOpen: boolean;
      cite: string | null;
      citeText: string;
    }>(`(async () => {
      const drawer = document.getElementById("drawer");
      for (let i = 0; i < 40; i++) {
        if (document.body.classList.contains("drawer-open") && document.querySelector(".ctx-row.cite")) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      const cite = document.querySelector(".ctx-row.cite");
      return {
        drawerOpen: document.body.classList.contains("drawer-open") && drawer && !drawer.hidden,
        cite: cite ? cite.getAttribute("data-start") : null,
        citeText: cite ? (cite.querySelector(".ctx-sum")?.textContent || "") : "",
      };
    })()`);
    expect(after.drawerOpen).toBe(true);
    expect(after.cite).toBe("1");
    expect(after.citeText).toContain("15");
    writeFileSync(`${SHOTS}/recall-drawer.png`, await driver.session.screenshot());
  } finally {
    driver.close();
    booted.stop();
  }
}, 30000);

async function waitChips(driver: { session: { evaluate: (expr: string) => Promise<unknown> } }): Promise<void> {
  await driver.session.evaluate(`new Promise((resolve) => {
    const ready = () => document.querySelectorAll(".recall-chip").length >= 3;
    if (ready()) return resolve(true);
    const obs = new MutationObserver(() => { if (ready()) { obs.disconnect(); resolve(true); } });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => resolve(Boolean(ready())), 6000);
  })`);
}
