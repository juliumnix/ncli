import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { agentTrio } from "../src/ui/chrome";
import { makeHub, shotsDir, waitUntil } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("client trio stays in lockstep with CliPresence", () => {
  expect(indexHtml).toContain('id="agentTrio"');
  expect(appJs).toContain("function agentTrio");
  expect(appJs).toContain("function renderAgentTrio");
  expect(appJs).toContain('["claude", "codex", "cursor"]');
  expect(appJs).toContain("main: seat === main && present");
  expect(agentTrio({ claude: true, codex: true, cursor: false }, "claude").filter((r) => r.present).map((r) => r.seat)).toEqual([
    "claude",
    "codex",
  ]);
});

test("chrome: empty session shows the three-agent trio", async () => {
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
      () => driver!.session.evaluate(`Boolean(document.querySelector(".welcome") && document.querySelectorAll(".trio-seat").length === 3)`),
      8000,
      "agent trio",
    );
    const facts = await driver.session.evaluate<{
      seats: string[];
      main: string;
      switcher: boolean;
      clash: number;
      claude: string;
    }>(`(() => {
      const seats = [...document.querySelectorAll(".trio-seat")].map((el) => el.getAttribute("data-seat") || "");
      const main = document.querySelector(".trio-seat.on")?.getAttribute("data-seat") || "";
      const claude = document.querySelector('[data-seat="claude"]');
      return {
        seats,
        main,
        switcher: Boolean(document.getElementById("switchBtn")),
        clash: document.querySelectorAll(".trio-seat.on.off").length,
        claude: claude ? claude.className : "",
      };
    })()`);
    expect(facts.seats).toEqual(["claude", "codex", "cursor"]);
    expect(facts.clash).toBe(0);
    expect(facts.switcher).toBe(true);
    if (facts.claude.includes("off")) expect(facts.main).toBe("");
    else expect(facts.main).toBe("claude");
    const dir = shotsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-trio.png"), await driver.session.screenshot());
  } finally {
    driver?.close();
    booted.stop();
  }
}, 30000);

test("chrome: missing main CLI is off, never on+off", async () => {
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
      () => driver!.session.evaluate(`document.querySelectorAll(".trio-seat").length === 3`),
      8000,
      "agent trio",
    );
    const facts = await driver.session.evaluate<{ claude: string; clash: number }>(`(() => {
      const claude = document.querySelector('[data-seat="claude"]');
      return {
        claude: claude ? claude.className : "",
        clash: document.querySelectorAll(".trio-seat.on.off").length,
      };
    })()`);
    expect(facts.claude).toContain("off");
    expect(facts.claude).not.toMatch(/(^|\s)on(\s|$)/);
    expect(facts.clash).toBe(0);
  } finally {
    driver?.close();
    booted.stop();
  }
}, 30000);
