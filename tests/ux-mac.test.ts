import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, waitUntil } from "./helpers";

const appJs = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");

test("hideOverlay drops rv-open and openSpark before the motion wait", () => {
  expect(appJs).toContain("function hideOverlay");
  expect(appJs).toContain("overlayGen += 1");
  expect(appJs).not.toMatch(/function hideOverlay\(\) \{\s*overlay\.hidden = true/);
  const hide = appJs.slice(appJs.indexOf("function hideOverlay"), appJs.indexOf("function jumpReview"));
  expect(hide.indexOf('document.body.classList.remove("rv-open")')).toBeGreaterThan(-1);
  expect(hide.indexOf("state.openSpark = null")).toBeGreaterThan(-1);
  expect(hide.indexOf("state.openSpark = null")).toBeLessThan(hide.indexOf("waitMotion(overlay)"));
});

test("send does not pin to the last user bubble", () => {
  expect(appJs).toContain("const atFloor = !chat || chat.scrollHeight - chat.scrollTop - chat.clientHeight <= STICK_SLOP");
  const send = appJs.slice(appJs.indexOf("async function sendUser"), appJs.indexOf('$("form").addEventListener("submit"'));
  expect(send).not.toContain("pinNewAnswer()");
  expect(send).toContain("stick.follow = false");
  expect(send).not.toContain("revealOwn");
});

test("Reviewed flips the button before the act fetch", () => {
  expect(appJs).toContain("function paintReviewedButton");
  const click = appJs.slice(appJs.indexOf('if (act === "review-file"'), appJs.indexOf('if (act === "other")'));
  expect(click.indexOf("paintReviewedButton")).toBeLessThan(click.indexOf("fetch("));
  expect(click).not.toContain("await openSpark");
});

async function chromeReview() {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  hub.memory.append({ kind: "user", text: "abre o review" });
  const rt = await hub.sparks.open("review", { pr: "482" });
  hub.cfg.port = 17100 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(14100 + Math.floor(Math.random() * 400));
  return { hub, booted, driver, sparkId: rt.spark.id };
}

test("chrome: open, close, and reopen a review spark three times", async () => {
  const { hub, booted, driver, sparkId } = await chromeReview();
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.querySelector('[data-spark="${sparkId}"]'))`),
      8000,
      "spark pill",
    );
    for (let i = 0; i < 3; i++) {
      await driver.session.evaluate(`document.querySelector('[data-spark="${sparkId}"]')?.click()`);
      await waitUntil(
        () => driver.session.evaluate(`Boolean(document.querySelector("#overlay.in") && document.querySelector(".rv-rev"))`),
        8000,
        `open ${i + 1}`,
      );
      await driver.session.evaluate(`document.getElementById("closeModal")?.click()`);
      await waitUntil(
        () => driver.session.evaluate(`!document.body.classList.contains("rv-open")`),
        4000,
        `close ${i + 1}`,
      );
    }
    await driver.session.evaluate(`document.querySelector('[data-spark="${sparkId}"]')?.click()`);
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.querySelector("#overlay.in") && document.querySelector(".rv-rev"))`),
      8000,
      "open after 3 closes",
    );
  } finally {
    driver.close();
    booted.stop();
    hub.close();
  }
});

test("chrome: Reviewed paint is under 16ms and the mark persists", async () => {
  const { hub, booted, driver, sparkId } = await chromeReview();
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.querySelector('[data-spark="${sparkId}"]'))`),
      8000,
      "spark pill",
    );
    await driver.session.evaluate(`document.querySelector('[data-spark="${sparkId}"]')?.click()`);
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.querySelector(".rv-rev"))`),
      8000,
      "reviewed button",
    );
    const measured = await driver.session.evaluate<{ ms: number; on: boolean }>(`(() => {
      const btn = document.querySelector(".rv-rev");
      if (!btn) return { ms: 999, on: false };
      const t0 = performance.now();
      btn.click();
      const on = btn.classList.contains("on");
      return { ms: performance.now() - t0, on };
    })()`);
    expect(measured.on).toBe(true);
    expect(measured.ms).toBeLessThan(16);
    await waitUntil(async () => {
      const spark = hub.sparks.list().find((s) => s.id === sparkId);
      const ui = spark?.ui as {
        fileState?: Array<{ reviewed?: boolean }>;
        chapters?: Array<{ reviewed?: boolean }>;
      } | undefined;
      return Boolean(ui?.fileState?.some((f) => f.reviewed) || ui?.chapters?.some((c) => c.reviewed));
    }, 4000, "reviewed persisted");
  } finally {
    driver.close();
    booted.stop();
    hub.close();
  }
});

test("chrome: sending a message keeps scroll when the user is not at the floor", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  for (let i = 0; i < 80; i++) {
    hub.memory.append({
      kind: i % 2 === 0 ? "user" : "talk",
      text: `linha ${i} ${"palavra ".repeat(8)}`,
    });
  }
  hub.cfg.port = 17200 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(14200 + Math.floor(Math.random() * 400));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`document.querySelectorAll("#log [data-mid]").length > 5`),
      8000,
      "seeded chat",
    );
    await driver.session.evaluate(`(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))()`);
    const before = await driver.session.evaluate<number>(`(() => {
      const chat = document.getElementById("chat");
      if (!chat) return -1;
      chat.scrollTop = 120;
      chat.dispatchEvent(new Event("scroll"));
      return chat.scrollTop;
    })()`);
    expect(before).toBeGreaterThan(40);
    await driver.session.evaluate(`(() => {
      const input = document.getElementById("input");
      const form = document.getElementById("form");
      if (!input || !form) return;
      input.value = "nao me arrasta";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    })()`);
    await Bun.sleep(200);
    const after = await driver.session.evaluate<number>(`document.getElementById("chat")?.scrollTop ?? -1`);
    expect(Math.abs(after - before)).toBeLessThan(16);
  } finally {
    driver.close();
    booted.stop();
    hub.close();
  }
});
