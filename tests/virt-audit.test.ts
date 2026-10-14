import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { STATE_PAGE } from "../src/state-page";
import { makeHub, waitUntil } from "./helpers";

const app = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
const css = readFileSync(join(import.meta.dir, "../public/app.css"), "utf8");
const html = readFileSync(join(import.meta.dir, "../public/index.html"), "utf8");
const root = join(import.meta.dir, "..");

function p95(values: number[]): number {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, i)] ?? Number.POSITIVE_INFINITY;
}

function seedLong(hub: Awaited<ReturnType<typeof makeHub>>["hub"], n = 240) {
  hub.memory.ingest(
    Array.from({ length: n }, (_, i) => ({
      kind: (i % 3 === 0 ? "user" : "talk") as "user" | "talk",
      text: `linha ${i} com **markdown** e um pouco de texto ${"x".repeat(24)}`,
    })),
  );
  hub.memory.append({
    kind: "talk",
    text: "```ncli html\n<p>preview live</p>\n```",
    seat: "claude",
  });
}

test("send and turn events patch one row and never rebuild the log", () => {
  expect(app).toContain("function echoUser");
  expect(app).toContain("function patchMessage");
  expect(app).toContain("function revealOwn");
  expect(app).toContain("function finishTurn");
  expect(app).toContain("function reuseLiveFrames");
  expect(app).toContain("data-live-key");
  expect(app).toContain("background:#151518");
  expect(app).toContain('class="m stream"');
  expect(app).toContain("work-disc");
  expect(app).toContain("histFindToggle");
  const sendStart = app.indexOf("async function sendUser");
  const send = app.slice(sendStart, app.indexOf('$("form").addEventListener', sendStart));
  expect(send).toContain("echoUser");
  expect(send).toContain("paintLive");
  expect(send).toContain("atFloor");
  expect(send).not.toContain("revealOwn");
  expect(send).not.toContain("syncChat");
  expect(send).not.toContain("renderChat");
  expect(send).not.toContain("scheduleFullPaint");
  expect(send).not.toContain("paintVirt");
  const msg = app.slice(app.indexOf('case "message"'), app.indexOf('case "delta"'));
  expect(msg).toContain("patchMessage");
  expect(msg).not.toContain("scheduleFullPaint");
  const turn = app.slice(app.indexOf('case "turn"'), app.indexOf('case "step"'));
  expect(turn).toContain("finishTurn");
  expect(turn).not.toContain("scheduleFullPaint");
  expect(turn).not.toContain("dropStreamNode");
  expect(send).toContain("snapToFloor");
  expect(app).toContain("function syncPref");
  expect(app).toContain("if (!virt.heights.size) return n * EST_H");
  expect(app).toContain("function confirmLiveUrl");
  expect(app).not.toContain("if (virt.count !== prev) syncPref");
  expect(app).toContain("node.dataset.mid !== mid");
  expect(app).toContain("if (node === cursor)");
  expect(app).not.toContain("gap.appendChild(node)");
});

test("hist is a hover scrubber and ⌘K find, with no native date field", () => {
  expect(html).not.toContain('type="date"');
  expect(html).toContain('id="histFind"');
  expect(html).toContain('id="histStart"');
  expect(html).toContain('id="histTrack"');
  expect(css).toContain("contain-intrinsic-size: auto var(--row-h, 240px)");
  expect(css).toContain(".log.turning");
  expect(css).toContain(".live-wrap:not(.ready)::after");
  expect(css).toContain(".hist-find");
  expect(css).toContain("body.scrolling .hist");
  expect(css).not.toMatch(/\.hist button[\s\S]{0,80}font:\s*10px/);
  expect(css).not.toMatch(/input\[type=["']date["']\]/);
});

test("chrome: long chat opens on the floor and Enter appends one row", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  seedLong(hub, 240);
  hub.cfg.port = 0;
  const booted = await bootNcli({ cfg: hub.cfg, hub, root });
  const driver = await launchChrome(24000 + (Date.now() % 8000), [
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
  ]);
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`document.querySelectorAll("#log [data-mid]").length > 2`),
      15000,
      "virt paint",
    );
    await driver.session.evaluate(`(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))()`);
    const opened = await driver.session.evaluate<{ leftover: number; jump: boolean; count: number }>(`(() => {
      const chat = document.getElementById("chat");
      const jump = document.getElementById("jumpLatest");
      if (!chat) return { leftover: 9999, jump: true, count: 0 };
      return {
        leftover: chat.scrollHeight - chat.scrollTop - chat.clientHeight,
        jump: Boolean(jump && !jump.hidden && jump.classList.contains("show")),
        count: document.querySelectorAll("#log [data-mid]").length,
      };
    })()`);
    expect(opened.leftover).toBeLessThanOrEqual(2);
    expect(opened.jump).toBe(false);
    expect(opened.count).toBeLessThan(STATE_PAGE);
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.querySelector("iframe.live-frame"))`),
      8000,
      "live iframe",
    );
    const reused = await driver.session.evaluate<{ sameWin: boolean }>(`(async () => {
      const log = document.getElementById("log");
      const form = document.getElementById("form");
      const input = document.getElementById("input");
      const frame = log && log.querySelector("iframe.live-frame");
      if (!log || !form || !input || !frame) return { sameWin: false };
      const beforeWin = frame.contentWindow;
      input.value = "reuse-iframe";
      form.requestSubmit();
      await new Promise((r) => requestAnimationFrame(r));
      const after = log.querySelector("iframe.live-frame");
      return { sameWin: Boolean(beforeWin && after && after.contentWindow === beforeWin) };
    })()`);
    expect(reused.sameWin).toBe(true);

    const sent = await driver.session.evaluate<{
      samples: number[];
      wipes: number[];
      sameWin: boolean;
    }>(`(async () => {
      const log = document.getElementById("log");
      const input = document.getElementById("input");
      const form = document.getElementById("form");
      if (!log || !input || !form) return { samples: [], wipes: [99], sameWin: false };
      const proto = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
      const wipes = [];
      if (proto && proto.set) {
        Object.defineProperty(log, "innerHTML", {
          configurable: true,
          get() { return proto.get.call(this); },
          set(v) { wipes.push(1); proto.set.call(this, v); },
        });
      }
      const samples = [];
      const waitIdle = async () => {
        for (let k = 0; k < 180; k++) {
          if (!log.querySelector(".m.stream") && !document.querySelector(".live.quiet")) return;
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      for (let i = 0; i < 8; i++) {
        await waitIdle();
        const mark = "eco-" + i + "-" + Date.now().toString(36);
        input.value = mark;
        const t0 = performance.now();
        form.requestSubmit();
        let found = false;
        for (let k = 0; k < 30; k++) {
          const hit = [...log.querySelectorAll(".u")].some((n) => (n.textContent || "").includes(mark));
          if (hit) { found = true; break; }
          await new Promise((r) => requestAnimationFrame(r));
        }
        samples.push(found ? performance.now() - t0 : 999);
      }
      return { samples, wipes };
    })()`);
    expect(p95(sent.samples)).toBeLessThan(16);
    expect(sent.wipes.length).toBe(0);
  } finally {
    driver.close();
    booted.stop();
    hub.close();
  }
}, 60000);

test("chrome: send while scrolled up keeps the user bubble above the composer", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  seedLong(hub, 180);
  hub.cfg.port = 0;
  const booted = await bootNcli({ cfg: hub.cfg, hub, root });
  const driver = await launchChrome(25000 + (Date.now() % 8000));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`document.querySelectorAll("#log [data-mid]").length > 2`),
      15000,
      "virt paint",
    );
    const rest = await driver.session.evaluate<{ date: number; find: boolean }>(`(() => ({
      date: document.querySelectorAll('input[type="date"]').length,
      find: Boolean(document.getElementById("histFind")),
    }))()`);
    expect(rest.date).toBe(0);
    expect(rest.find).toBe(true);

    await driver.session.evaluate(`(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))()`);
    await driver.session.evaluate(`(() => {
      const chat = document.getElementById("chat");
      chat.scrollTop = 0;
      chat.dispatchEvent(new Event("scroll"));
    })()`);
    await waitUntil(
      () => driver.session.evaluate(`(() => {
        const chat = document.getElementById("chat");
        return Boolean(chat && chat.scrollTop <= 8 && chat.scrollHeight - chat.scrollTop - chat.clientHeight > 200);
      })()`),
      4000,
      "scrolled up",
    );
    const fact = await driver.session.evaluate<{
      top: number;
      pill: string;
      quiet: number;
      findOpen: boolean;
    }>(`(async () => {
      const chat = document.getElementById("chat");
      const input = document.getElementById("input");
      const form = document.getElementById("form");
      const before = chat ? chat.scrollTop : -1;
      if (!input || !form || !chat) {
        return { top: -1, pill: "", quiet: 1, findOpen: false };
      }
      const mark = "acima-" + Date.now().toString(36);
      input.value = mark;
      form.requestSubmit();
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
      await new Promise((r) => requestAnimationFrame(r));
      const find = document.getElementById("histFind");
      const jump = document.getElementById("jumpLatest");
      return {
        top: Math.abs((chat.scrollTop || 0) - before),
        pill: jump && !jump.hidden ? jump.textContent || "" : "",
        quiet: document.querySelectorAll(".live.quiet").length,
        findOpen: Boolean(find && find.classList.contains("open")),
      };
    })()`);
    expect(fact.top).toBeLessThan(16);
    expect(fact.pill).toMatch(/nova resposta|agora/);
    expect(fact.quiet).toBe(0);
    expect(fact.findOpen).toBe(true);
  } finally {
    driver.close();
    booted.stop();
    hub.close();
  }
}, 40000);
