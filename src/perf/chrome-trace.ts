import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromePath, launchChrome, type CdpSession } from "./cdp";
import type { PerfSample } from "./types";

export function browserAvailable(): boolean {
  return Boolean(chromePath());
}

export async function measureBrowser(uiUrl: string, screenshotDir?: string): Promise<PerfSample[]> {
  const driver = await launchChrome(9222 + Math.floor(Math.random() * 400));
  const { session } = driver;
  try {
    await session.attachPage("about:blank");
    const samples: PerfSample[] = [];
    samples.push(await firstPaint(session, uiUrl));
    samples.push(await sendFeedback(session, screenshotDir));
    samples.push(await drawerOpen(session));
    samples.push(...(await forkModal(session)));
    samples.push(await longScroll(session));
    return samples;
  } finally {
    driver.close();
  }
}

async function firstPaint(session: CdpSession, uiUrl: string): Promise<PerfSample> {
  const t0 = performance.now();
  await session.send("Page.navigate", { url: uiUrl });
  await session.evaluate(`new Promise((resolve) => {
    if (document.readyState === "complete") resolve(true);
    else window.addEventListener("load", () => resolve(true), { once: true });
  })`);
  await session.evaluate(`new Promise((resolve) => {
    const ready = () => document.getElementById("log") && document.getElementById("input");
    if (ready()) return resolve(true);
    const obs = new MutationObserver(() => { if (ready()) { obs.disconnect(); resolve(true); } });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => resolve(Boolean(ready())), 4000);
  })`);
  const paint = await session.evaluate<number>(`(() => {
    const marks = performance.getEntriesByType("paint");
    const fp = marks.find((m) => m.name === "first-contentful-paint") || marks[0];
    return fp ? fp.startTime : performance.now();
  })()`);
  const nav = performance.now() - t0;
  return {
    metric: "first_paint",
    ms: Number.isFinite(paint) && paint > 0 ? paint : nav,
    ok: true,
    work: 1,
    note: "first-contentful-paint in chrome 1440x900",
  };
}

async function sendFeedback(session: CdpSession, screenshotDir?: string): Promise<PerfSample> {
  const result = await session.evaluate<{ ms: number; ok: boolean; shot?: boolean }>(` (async () => {
    const input = document.getElementById("input");
    const form = document.getElementById("form");
    if (!input || !form) return { ms: 0, ok: false };
    input.focus();
    input.value = "oi, me responde rápido";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const before = document.querySelectorAll("#log .u, #log .live").length;
    const t0 = performance.now();
    form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => {
      const done = () => {
        const after = document.querySelectorAll("#log .u, #log .live, #log .u.pending");
        if (after.length > before || document.querySelector("#log .live, #log .u:last-child")) resolve(true);
      };
      const obs = new MutationObserver(done);
      obs.observe(document.getElementById("log"), { childList: true, subtree: true, characterData: true });
      done();
      setTimeout(() => { obs.disconnect(); resolve(false); }, 4000);
    });
    return { ms: performance.now() - t0, ok: Boolean(document.querySelector("#log .u, #log .live")) };
  })()`);
  if (screenshotDir && result.ok) {
    mkdirSync(screenshotDir, { recursive: true });
    const png = await session.screenshot();
    writeFileSync(join(screenshotDir, "send-to-first-feedback.png"), png);
  }
  return {
    metric: "send_to_feedback",
    ms: result.ms,
    ok: result.ok,
    work: result.ok ? 1 : 0,
    note: "chrome DOM, 1440x900",
  };
}

async function drawerOpen(session: CdpSession): Promise<PerfSample> {
  const ms = await session.evaluate<number>(`(() => {
    const btn = document.getElementById("menuBtn");
    const drawer = document.getElementById("drawer");
    if (!btn || !drawer) return -1;
    if (!drawer.hidden) btn.click();
    const t0 = performance.now();
    btn.click();
    const opened = !drawer.hidden || document.body.classList.contains("drawer-open");
    return opened ? performance.now() - t0 : -1;
  })()`);
  return {
    metric: "memory_drawer_open",
    ms: ms >= 0 ? ms : 0,
    ok: ms >= 0,
    work: ms >= 0 ? 1 : 0,
  };
}

async function forkModal(session: CdpSession): Promise<PerfSample[]> {
  const result = await session.evaluate<{ open: number; close: number; ok: boolean }>(`(async () => {
    const overlay = document.getElementById("overlay");
    const t0 = performance.now();
    const res = await fetch("/api/forks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: "live", params: {} }),
    });
    const json = await res.json();
    const id = json.fork && json.fork.id;
    if (!id) return { open: 0, close: 0, ok: false };
    const pill = document.querySelector("[data-fork='" + id + "']") || document.querySelector("[data-fork]");
    if (pill) pill.click();
    else {
      const r = await fetch("/api/forks/" + encodeURIComponent(id));
      if (!r.ok) return { open: 0, close: 0, ok: false };
    }
    await new Promise((resolve) => {
      const ready = () => overlay && !overlay.hidden;
      if (ready()) return resolve(true);
      const obs = new MutationObserver(() => { if (ready()) { obs.disconnect(); resolve(true); } });
      if (overlay) obs.observe(overlay, { attributes: true, childList: true, subtree: true });
      setTimeout(() => resolve(Boolean(ready())), 3000);
    });
    const open = performance.now() - t0;
    const t1 = performance.now();
    const closeBtn = document.getElementById("closeModal");
    if (closeBtn) closeBtn.click();
    else if (overlay) overlay.click();
    await new Promise((r) => setTimeout(r, 40));
    return { open, close: performance.now() - t1, ok: true };
  })()`);
  return [
    {
      metric: "fork_modal_open",
      ms: result.open,
      ok: result.ok,
      work: result.ok ? 1 : 0,
    },
    {
      metric: "fork_modal_close",
      ms: result.close,
      ok: result.ok,
      work: result.ok ? 1 : 0,
    },
  ];
}

async function longScroll(session: CdpSession): Promise<PerfSample> {
  const ms = await session.evaluate<number>(`(async () => {
    const chat = document.getElementById("chat");
    if (!chat) return -1;
    const t0 = performance.now();
    chat.scrollTop = 0;
    chat.scrollTop = chat.scrollHeight;
    chat.scrollTop = Math.floor(chat.scrollHeight / 2);
    chat.dispatchEvent(new Event("scroll"));
    return performance.now() - t0;
  })()`);
  return {
    metric: "long_chat_scroll",
    ms: ms >= 0 ? ms : 0,
    ok: ms >= 0,
    work: 1,
  };
}
