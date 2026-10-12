import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bootNcli } from "../src/boot";
import { MockHarness } from "../src/harness/mock";
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
  expect(appJs).toContain("chat.scrollTop > 0");
  expect(appJs).toContain("function dropStreamNode");
  expect(appJs).toMatch(/function snapToFloor\(\) \{[\s\S]*?userUp = false/);
  expect(appJs).toMatch(/function jumpToLatest\(\) \{[\s\S]*?userUp = false/);
  expect(appJs).toMatch(/ResizeObserver\(\(\) => \{[\s\S]*?paintScrollHints\(\)/);
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
    await waitChatReady(driver);
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

test("chrome: wheel at the top then jump still reaches the floor", async () => {
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
    await waitChatReady(driver);
    const jumped = await driver.session.evaluate<{ leftover: number; max: number; top: number; hidden: boolean }>(`(async () => {
      const chat = document.getElementById("chat");
      chat.scrollTop = 0;
      chat.dispatchEvent(new Event("scroll"));
      for (let i = 0; i < 12; i++) {
        chat.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
      }
      const jump = document.getElementById("jumpLatest");
      jump.click();
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => requestAnimationFrame(() => r(true)));
        const max = Math.max(0, chat.scrollHeight - chat.clientHeight);
        if (max - chat.scrollTop <= 1) {
          return { top: chat.scrollTop, max, leftover: max - chat.scrollTop, hidden: jump.hidden };
        }
      }
      const max = Math.max(0, chat.scrollHeight - chat.clientHeight);
      return { top: chat.scrollTop, max, leftover: max - chat.scrollTop, hidden: jump.hidden };
    })()`);
    expect(jumped.max).toBeGreaterThan(200);
    expect(jumped.leftover).toBeLessThanOrEqual(64);
    expect(jumped.hidden).toBe(true);
  } finally {
    driver.close();
    booted.stop();
  }
}, 25000);

test("chrome: composer ring is Tab-only, not mouse click", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub({ demo: true });
  hub.memory.append({ kind: "talk", text: LONG, seat: "claude" });
  hub.cfg.port = 18200 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(9400 + Math.floor(Math.random() * 400));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await driver.session.evaluate(`new Promise((resolve) => {
      const ready = () => document.getElementById("form") && document.getElementById("input");
      if (ready()) return resolve(true);
      const obs = new MutationObserver(() => { if (ready()) { obs.disconnect(); resolve(true); } });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => resolve(Boolean(ready())), 4000);
    })`);
    const mouse = await driver.session.evaluate<{ fromKey: boolean; ring: boolean }>(`(() => {
      const form = document.getElementById("form");
      const input = document.getElementById("input");
      form.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      input.focus();
      const shadow = getComputedStyle(form).boxShadow;
      const accent = getComputedStyle(form).getPropertyValue("--accent").trim() ||
        getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      return { fromKey: form.classList.contains("from-key"), shadow, accent };
    })()`);
    expect(mouse.fromKey).toBe(false);
    expect(mouse.shadow.includes("rgb(110, 164, 255)")).toBe(false);
    const keyed = await driver.session.evaluate<{ fromKey: boolean; shadow: string }>(`(() => {
      const form = document.getElementById("form");
      const input = document.getElementById("input");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      input.focus();
      return { fromKey: form.classList.contains("from-key"), shadow: getComputedStyle(form).boxShadow };
    })()`);
    expect(keyed.fromKey).toBe(true);
    expect(keyed.shadow.includes("rgb(110, 164, 255)")).toBe(true);
    expect(keyed.shadow).not.toBe(mouse.shadow);
  } finally {
    driver.close();
    booted.stop();
  }
}, 25000);

test("chrome: a finished turn while scrolled up keeps the jump button", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const harness = new MockHarness(() => ({ text: LONG }));
  const { hub } = await makeHub({ demo: true, harness });
  for (let i = 0; i < 8; i++) {
    hub.memory.append({ kind: "talk", text: LONG, seat: "claude" });
  }
  hub.cfg.port = 18200 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(9400 + Math.floor(Math.random() * 400));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitChatReady(driver);
    await driver.session.evaluate(`(() => {
      const chat = document.getElementById("chat");
      chat.scrollTop = 0;
      chat.dispatchEvent(new Event("scroll"));
    })()`);
    const send = hub.send("continua o texto longo");
    const after = await driver.session.evaluate<{ leftover: number; hidden: boolean; stream: number; live: number; followClass: boolean }>(`(async () => {
      const chat = document.getElementById("chat");
      const jump = document.getElementById("jumpLatest");
      for (let i = 0; i < 160; i++) {
        await new Promise((r) => setTimeout(r, 40));
        const live = document.querySelector(".live.quiet");
        if (!live && document.querySelectorAll(".m").length > 6) break;
      }
      for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(() => r(true)));
      const max = Math.max(0, chat.scrollHeight - chat.clientHeight);
      const log = document.getElementById("log");
      return {
        leftover: max - chat.scrollTop,
        hidden: jump.hidden,
        stream: log.querySelectorAll(":scope > .m.stream").length,
        live: document.querySelectorAll(".live.quiet").length,
        followClass: jump.classList.contains("show"),
      };
    })()`);
    await send;
    expect(after.leftover).toBeGreaterThan(400);
    expect(after.stream).toBe(0);
    expect(after.live).toBe(0);
    expect(after.hidden).toBe(false);
    expect(after.followClass).toBe(true);
  } finally {
    driver.close();
    booted.stop();
  }
}, 30000);

async function waitChatReady(driver: { session: { evaluate: (expr: string) => Promise<unknown> } }): Promise<void> {
  await driver.session.evaluate(`new Promise((resolve) => {
    const ready = () => {
      const chat = document.getElementById("chat");
      const log = document.getElementById("log");
      return chat && log && log.children.length > 0 && chat.scrollHeight > chat.clientHeight + 80;
    };
    if (ready()) return resolve(true);
    const root = document.documentElement || document.body;
    if (!root) {
      setTimeout(() => resolve(Boolean(ready())), 6000);
      return;
    }
    const obs = new MutationObserver(() => { if (ready()) { obs.disconnect(); resolve(true); } });
    obs.observe(root, { childList: true, subtree: true });
    window.addEventListener("load", () => { if (ready()) resolve(true); }, { once: true });
    setTimeout(() => resolve(Boolean(ready())), 6000);
  })`);
}
