import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const LONG = Array.from({ length: 12 }, (_, i) => `Parágrafo ${i + 1}. ${"linha longa para forçar o scroller.\n".repeat(6)}`).join("\n");

test("app.js ignores its own scroll frames and only unfollows a user-up gesture", () => {
  expect(appJs).toContain("programmaticScroll");
  expect(appJs).toContain("function setChatTop");
  expect(appJs).toContain("function snapToFloor");
  expect(appJs).toContain("function bindChatFloor");
  expect(appJs).toMatch(/userUp|markUserUp/);
  expect(appJs).not.toMatch(
    /chat\.addEventListener\("scroll",\s*\(\)\s*=>\s*\{\s*stick\.follow\s*=\s*chat\.scrollHeight/,
  );
});

test("chrome: the page opens on the floor and jump-to-latest finishes there", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub({ demo: true });
  for (let i = 0; i < 8; i++) {
    hub.memory.append({ kind: "talk", text: LONG, seat: "claude" });
  }
  hub.cfg.port = 18200 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(9400 + Math.floor(Math.random() * 400));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await driver.session.evaluate(`new Promise((resolve) => {
      const ready = () => {
        const chat = document.getElementById("chat");
        const log = document.getElementById("log");
        return chat && log && log.children.length > 4 && chat.scrollHeight > chat.clientHeight + 200;
      };
      if (document.readyState === "complete" && ready()) return resolve(true);
      const obs = new MutationObserver(() => { if (ready()) { obs.disconnect(); resolve(true); } });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      window.addEventListener("load", () => { if (ready()) resolve(true); }, { once: true });
      setTimeout(() => resolve(Boolean(ready())), 6000);
    })`);
    const opened = await driver.session.evaluate<{ top: number; max: number; leftover: number }>(`(async () => {
      const chat = document.getElementById("chat");
      for (let i = 0; i < 40; i++) {
        const max = Math.max(0, chat.scrollHeight - chat.clientHeight);
        if (max > 200 && max - chat.scrollTop <= 64) {
          return { top: chat.scrollTop, max, leftover: max - chat.scrollTop };
        }
        await new Promise((r) => requestAnimationFrame(() => r(true)));
      }
      const max = Math.max(0, chat.scrollHeight - chat.clientHeight);
      return { top: chat.scrollTop, max, leftover: max - chat.scrollTop };
    })()`);
    expect(opened.max).toBeGreaterThan(200);
    expect(opened.leftover).toBeLessThanOrEqual(64);

    await driver.session.evaluate(`(() => {
      const chat = document.getElementById("chat");
      chat.scrollTop = 0;
      chat.dispatchEvent(new Event("scroll"));
    })()`);
    await driver.session.evaluate(`new Promise((r) => requestAnimationFrame(() => r(true)))`);

    const jumped = await driver.session.evaluate<{ top: number; max: number; leftover: number; frames: number }>(`(async () => {
      const jump = document.getElementById("jumpLatest");
      if (jump) jump.click();
      let frames = 0;
      for (; frames < 90; frames++) {
        await new Promise((r) => requestAnimationFrame(() => r(true)));
        const chat = document.getElementById("chat");
        const max = Math.max(0, chat.scrollHeight - chat.clientHeight);
        if (max - chat.scrollTop <= 1) {
          return { top: chat.scrollTop, max, leftover: max - chat.scrollTop, frames };
        }
      }
      const chat = document.getElementById("chat");
      const max = Math.max(0, chat.scrollHeight - chat.clientHeight);
      return { top: chat.scrollTop, max, leftover: max - chat.scrollTop, frames };
    })()`);
    expect(jumped.max).toBeGreaterThan(200);
    expect(jumped.leftover).toBeLessThanOrEqual(64);
    expect(jumped.top).toBeGreaterThan(jumped.max * 0.9);
  } finally {
    driver.close();
    booted.stop();
  }
}, 25000);
