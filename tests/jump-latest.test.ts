import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bootNcli } from "../src/boot";
import { MockHarness } from "../src/harness/mock";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, waitUntil } from "./helpers";

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
    const opened = await waitChatFloor(driver, (s) => s.max > 200 && s.leftover <= 64, "open on floor");
    expect(opened.max).toBeGreaterThan(200);
    expect(opened.leftover).toBeLessThanOrEqual(64);

    await driver.session.evaluate(`(() => {
      const chat = document.getElementById("chat");
      chat.scrollTop = 0;
      chat.dispatchEvent(new Event("scroll"));
    })()`);
    await waitUntil(
      async () => (await chatFloor(driver)).top === 0,
      8000,
      "scrolled to top",
    );

    await driver.session.evaluate(`document.getElementById("jumpLatest")?.click()`);
    const jumped = await waitChatFloor(driver, (s) => s.max > 200 && s.leftover <= 64, "jump to floor");
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
    await driver.session.evaluate(`(() => {
      const chat = document.getElementById("chat");
      chat.scrollTop = 0;
      chat.dispatchEvent(new Event("scroll"));
      for (let i = 0; i < 12; i++) {
        chat.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
      }
      document.getElementById("jumpLatest")?.click();
    })()`);
    const jumped = await waitChatFloor(driver, (s) => s.max > 200 && s.leftover <= 64 && s.hidden, "wheel then jump");
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
    await waitUntil(
      () => driver.session.evaluate(`(() => {
        const form = document.getElementById("form");
        const input = document.getElementById("input");
        if (!form || !input) return false;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        return form.classList.contains("from-key");
      })()`),
      8000,
      "tab handler",
    );
    const mouse = await driver.session.evaluate<{ fromKey: boolean; shadow: string }>(`(() => {
      const form = document.getElementById("form");
      const input = document.getElementById("input");
      document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      input.focus();
      return { fromKey: form.classList.contains("from-key"), shadow: getComputedStyle(form).boxShadow };
    })()`);
    expect(mouse.fromKey).toBe(false);
    expect(mouse.shadow.includes("rgb(110, 164, 255)")).toBe(false);
    await waitUntil(
      () => driver.session.evaluate(`(() => {
        const form = document.getElementById("form");
        const input = document.getElementById("input");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        input.focus();
        return form.classList.contains("from-key") && getComputedStyle(form).boxShadow.includes("rgb(110, 164, 255)");
      })()`),
      8000,
      "composer ring",
    );
    const keyed = await driver.session.evaluate<{ fromKey: boolean; shadow: string }>(`(() => {
      const form = document.getElementById("form");
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
    await driver.session.evaluate(`(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))()`);
    await driver.session.evaluate(`(() => {
      const chat = document.getElementById("chat");
      chat.scrollTop = Math.max(0, (chat.scrollHeight - chat.clientHeight) / 2);
      chat.dispatchEvent(new Event("scroll"));
      chat.scrollTop = 0;
      chat.dispatchEvent(new Event("scroll"));
    })()`);
    await waitChatFloor(driver, (s) => s.top <= 8 && s.leftover > 400 && s.hidden === false, "stay at top");
    const send = hub.send("continua o texto longo");
    let after = { leftover: 0, hidden: true, stream: 1, live: 1, followClass: false };
    await waitUntil(async () => {
      after = await driver.session.evaluate<{ leftover: number; hidden: boolean; stream: number; live: number; followClass: boolean }>(`(() => {
        const chat = document.getElementById("chat");
        const jump = document.getElementById("jumpLatest");
        const log = document.getElementById("log");
        if (!chat || !jump || !log) return { leftover: 0, hidden: true, stream: 1, live: 1, followClass: false };
        const max = Math.max(0, chat.scrollHeight - chat.clientHeight);
        return {
          leftover: max - chat.scrollTop,
          hidden: jump.hidden,
          stream: log.querySelectorAll(":scope > .m.stream").length,
          live: document.querySelectorAll(".live.quiet").length,
          followClass: jump.classList.contains("show"),
        };
      })()`);
      return after.live === 0 && after.stream === 0 && after.leftover > 400 && after.hidden === false && after.followClass;
    }, 15000, "jump stays after turn");
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

type ChatFloor = { top: number; max: number; leftover: number; hidden: boolean };

async function chatFloor(driver: { session: { evaluate: <T>(expr: string) => Promise<T> } }): Promise<ChatFloor> {
  return driver.session.evaluate<ChatFloor>(`(() => {
    const chat = document.getElementById("chat");
    const jump = document.getElementById("jumpLatest");
    if (!chat) return { top: 0, max: 0, leftover: 0, hidden: true };
    const max = Math.max(0, chat.scrollHeight - chat.clientHeight);
    return { top: chat.scrollTop, max, leftover: max - chat.scrollTop, hidden: jump ? jump.hidden : true };
  })()`);
}

async function waitChatFloor(
  driver: { session: { evaluate: <T>(expr: string) => Promise<T> } },
  ok: (s: ChatFloor) => boolean,
  what: string,
): Promise<ChatFloor> {
  let last: ChatFloor = { top: 0, max: 0, leftover: 0, hidden: true };
  await waitUntil(async () => {
    last = await chatFloor(driver);
    return ok(last);
  }, 8000, what);
  return last;
}

async function waitChatReady(driver: { session: { evaluate: <T>(expr: string) => Promise<T> } }): Promise<void> {
  await waitUntil(
    () => driver.session.evaluate(`(() => {
      const chat = document.getElementById("chat");
      const log = document.getElementById("log");
      return Boolean(chat && log && log.children.length > 0 && chat.scrollHeight > chat.clientHeight + 80);
    })()`),
    8000,
    "chat ready",
  );
}
