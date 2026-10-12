import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { demo3dFence } from "../src/live/3d-demo";
import { ncli3dSrc } from "../src/live/3d-frame";
import { frameHtml, iframeTag } from "../src/live/frame";
import { liveBlocks, parseLive, renderToolToFence } from "../src/live/parse";
import { liveLabel, liveShape, shimmerHtml } from "../src/live/shimmer";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, waitUntil } from "./helpers";

function shots(): string {
  const fromEnv = process.env.NCLI_SHOTS?.trim();
  if (fromEnv) return fromEnv;
  return join(tmpdir(), "ncli-shots");
}

test("ncli 3d is a live kind and render keeps the fence", () => {
  const text = `Mesa.\n\n${demo3dFence()}`;
  expect(liveBlocks(text).map((b) => b.kind)).toEqual(["3d"]);
  expect(parseLive(text).some((s) => s.type === "live" && s.block.kind === "3d")).toBe(true);
  expect(renderToolToFence("3d", "ncli3d.desk()")).toBe("```ncli 3d\nncli3d.desk()\n```");
});

test("3d iframe vendors three.js from this hub and is first-party sandboxed", () => {
  const page = readFileSync(new URL("../public/ncli3d.html", import.meta.url), "utf8");
  expect(page).toContain("/ncli3d.js");
  expect(page).toContain("script-src 'self'");
  expect(page).not.toContain("cdn");
  expect(page).not.toContain("unpkg");
  expect(page).not.toContain("jsdelivr");
  expect(ncli3dSrc("ncli3d.desk()")).toBe("/ncli3d.html#" + encodeURIComponent("ncli3d.desk()"));
  const framed = iframeTag({ kind: "3d", source: "ncli3d.desk()" });
  expect(framed).toContain("live-3d");
  expect(framed).toContain('sandbox="allow-scripts allow-same-origin"');
  expect(framed).toContain('src="/ncli3d.html#');
  expect(framed).not.toContain("srcdoc=");
  expect(framed).not.toContain("ui-card");
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
  expect(js).toContain("function bind3dPause");
  expect(js).toContain("live-3d");
  expect(kit).toContain("export function desk");
  expect(kit).toContain("./vendor/three.module.min.js");
  expect(kit).toContain("MeshLambertMaterial");
  expect(kit).not.toContain("OrbitControls");
  expect(css).toContain(".live-frame.live-3d");
  const three = readFileSync(new URL("../public/vendor/three.module.min.js", import.meta.url), "utf8");
  expect(three).toContain("170");
  expect(three).toContain("@license");
});

test("chrome: a 3d fence paints a borderless scene in the chat", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  hub.memory.append({ kind: "talk", text: `Aqui a mesa.\n\n${demo3dFence()}`, seat: "claude" });
  hub.cfg.port = 19500 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(10000 + Math.floor(Math.random() * 400));
  const dir = shots();
  mkdirSync(dir, { recursive: true });
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () =>
        driver.session.evaluate(`(() => {
          const iframe = document.querySelector("iframe.live-3d");
          if (!iframe) return false;
          const doc = iframe.contentDocument;
          const canvas = doc?.querySelector("canvas");
          const cams = [...(doc?.querySelectorAll(".n3-cams button") || [])].map((b) => b.textContent);
          const st = iframe.contentWindow?.ncli3dState;
          const box = iframe.getBoundingClientRect();
          return Boolean(
            box.height >= 400 &&
              cams.includes("whole desk") &&
              cams.includes("close-up of clamp") &&
              canvas &&
              canvas.width >= 400 &&
              st?.renderer,
          );
        })()`),
      12000,
      "3d scene",
    );
    writeFileSync(join(dir, "ncli-3d-desk.png"), await driver.session.screenshot());
    const facts = await driver.session.evaluate<{
      card: boolean;
      height: number;
      title: string;
      src: string;
      buttons: string[];
      canvas: number[];
      triangles: number;
      engine: string;
    }>(`(() => {
      const iframe = document.querySelector("iframe.live-3d");
      const doc = iframe.contentDocument;
      const canvas = doc.querySelector("canvas");
      const box = iframe.getBoundingClientRect();
      const st = iframe.contentWindow.ncli3dState;
      return {
        card: Boolean(iframe.closest(".ui-card")),
        height: Math.round(box.height),
        title: iframe.getAttribute("title") || "",
        src: iframe.getAttribute("src") || "",
        buttons: [...doc.querySelectorAll("button")].map((b) => b.textContent),
        canvas: [canvas.width, canvas.height],
        triangles: st?.renderer?.info?.render?.triangles ?? 0,
        engine: canvas.getAttribute("data-engine") || "",
      };
    })()`);
    expect(facts.card).toBe(false);
    expect(facts.height).toBeGreaterThanOrEqual(400);
    expect(facts.title).toBe("live 3d");
    expect(facts.src).toContain("/ncli3d.html");
    expect(facts.buttons).toContain("whole desk");
    expect(facts.buttons).toContain("Wood top");
    expect(facts.canvas[0]).toBeGreaterThanOrEqual(400);
    expect(facts.triangles).toBeGreaterThan(0);
    expect(facts.engine).toContain("three.js r170");
  } finally {
    driver.close();
    booted.stop();
  }
}, 30000);
