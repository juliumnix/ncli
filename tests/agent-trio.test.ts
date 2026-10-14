import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { agentTrio } from "../src/ui/chrome";
import { makeHub, shotsDir, waitUntil } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("header switcher is one pill and the trio lives in the menu", () => {
  expect(indexHtml).not.toContain("agentTrio");
  expect(indexHtml).not.toContain("trio-seat");
  expect(appJs).toContain("function agentTrio");
  expect(appJs).not.toContain("function renderAgentTrio");
  expect(appJs).toContain('<span class="model">');
  expect(appJs).toContain('<i class="dot');
  expect(appJs).toContain('data-seat="${id}"');
  expect(appJs).toContain('["claude", "codex", "cursor"]');
  expect(appJs).toContain("main: seat === main && present");
  expect(agentTrio({ claude: true, codex: true, cursor: false }, "claude").filter((r) => r.present).map((r) => r.seat)).toEqual([
    "claude",
    "codex",
  ]);
});

test("chrome: header has one agent avatar and the menu lists three seats", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  hub.cfg.port = 19500 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    driver = await launchChrome(10050 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.getElementById("switchBtn") && document.querySelector(".welcome"))`),
      8000,
      "header switcher",
    );
    await driver.session.evaluate(`document.getElementById("switchBtn")?.click()`);
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.querySelector(".switch-menu.open") && document.querySelectorAll(".switch-opt[data-seat]").length === 3)`),
      4000,
      "switch menu",
    );
    const facts = await driver.session.evaluate<{
      headerAvatars: number;
      seats: string[];
      trio: number;
    }>(`(() => ({
      headerAvatars: document.querySelectorAll("#switchBtn .av").length,
      seats: [...document.querySelectorAll(".switch-opt[data-seat]")].map((el) => el.getAttribute("data-seat") || ""),
      trio: document.querySelectorAll(".trio-seat, #agentTrio").length,
    }))()`);
    expect(facts.headerAvatars).toBe(1);
    expect(facts.seats).toEqual(["claude", "codex", "cursor"]);
    expect(facts.trio).toBe(0);
    const dir = shotsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-trio.png"), await driver.session.screenshot());
  } finally {
    driver?.close();
    booted.stop();
    hub.close();
  }
}, 30000);

test("chrome: missing main CLI is off in the menu, never on+off", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  hub.cfg.claudeBin = "/no/such/ncli-claude";
  hub.cfg.port = 19600 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    driver = await launchChrome(10150 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.getElementById("switchBtn"))`),
      8000,
      "header switcher",
    );
    await driver.session.evaluate(`document.getElementById("switchBtn")?.click()`);
    await waitUntil(
      () => driver!.session.evaluate(`document.querySelectorAll(".switch-opt[data-seat]").length === 3`),
      4000,
      "switch menu",
    );
    const facts = await driver.session.evaluate<{ claude: string; clash: number }>(`(() => {
      const claude = document.querySelector('.switch-opt[data-seat="claude"]');
      return {
        claude: claude ? claude.className : "",
        clash: document.querySelectorAll(".switch-opt.on.off").length,
      };
    })()`);
    expect(facts.claude).toContain("off");
    expect(facts.claude).not.toMatch(/(^|\s)on(\s|$)/);
    expect(facts.clash).toBe(0);
  } finally {
    driver?.close();
    booted.stop();
    hub.close();
  }
}, 30000);
