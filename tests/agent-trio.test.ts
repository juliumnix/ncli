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
    const facts = await driver.session.evaluate<{ seats: string[]; main: string; switcher: boolean }>(`(() => {
      const seats = [...document.querySelectorAll(".trio-seat")].map((el) => el.getAttribute("data-seat") || "");
      const main = document.querySelector(".trio-seat.on")?.getAttribute("data-seat") || "";
      return { seats, main, switcher: Boolean(document.getElementById("switchBtn")) };
    })()`);
    expect(facts.seats).toEqual(["claude", "codex", "cursor"]);
    expect(facts.main).toBe("claude");
    expect(facts.switcher).toBe(false);
    const dir = shotsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-trio.png"), await driver.session.screenshot());
  } finally {
    driver?.close();
    booted.stop();
  }
}, 30000);
