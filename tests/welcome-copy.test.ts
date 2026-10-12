import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { userHelp } from "../src/ui/chrome";
import { makeHub, waitUntil } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function shots(): string {
  const fromEnv = process.env.NCLI_SHOTS?.trim();
  if (fromEnv) return fromEnv;
  return join(tmpdir(), "ncli-shots");
}

test("welcome, placeholder, and /help name a question, a PR URL, and /help", () => {
  expect(appJs).toContain("Escreve uma pergunta, cola o URL de um PR, ou /help");
  expect(appJs).toContain("Pergunta, URL de PR ou /help");
  expect(indexHtml).toContain("Pergunta, URL de PR ou /help");
  expect(userHelp()).toContain("Cola o URL de um pull request do GitHub pra abrir o review");
});

test("chrome: empty session hint names the PR paste path", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  hub.cfg.port = 19400 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    driver = await launchChrome(9900 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.querySelector(".welcome-hint"))`),
      8000,
      "welcome hint",
    );
    const facts = await driver.session.evaluate<{ hint: string; placeholder: string }>(`(() => ({
      hint: document.querySelector(".welcome-hint")?.textContent?.trim() || "",
      placeholder: document.getElementById("input")?.getAttribute("placeholder") || "",
    }))()`);
    expect(facts.hint).toContain("URL de um PR");
    expect(facts.placeholder).toContain("URL de PR");
    const dir = shots();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "welcome-copy.png"), await driver.session.screenshot());
  } finally {
    driver?.close();
    booted.stop();
  }
}, 30000);
