import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { iframeTag, frameHtml } from "../src/live/frame";
import { liveBlocks, parseLive, renderToolToFence } from "../src/live/parse";
import { liveLabel, liveShape, shimmerHtml } from "../src/live/shimmer";
import { DEMO_UI_SOURCE, demoUiFence } from "../src/live/ui-demo";
import { parseUiHostMsg, uiKey, wrapUiSource } from "../src/live/ui-frame";
import { assemble } from "../src/memory/assemble";
import { Memory, mockCompressor } from "../src/memory/store";
import { makeHub, tmpDir } from "./helpers";

test("ui fence is a live kind and render tool keeps it", () => {
  const text = `Card.\n\n${demoUiFence()}`;
  expect(liveBlocks(text).map((b) => b.kind)).toEqual(["ui"]);
  expect(parseLive(text).some((s) => s.type === "live" && s.block.kind === "ui")).toBe(true);
  expect(renderToolToFence("ui", "<div>ok</div>")).toBe("```ncli ui\n<div>ok</div>\n```");
});

test("wrap injects NCLI tokens, CSP, chart helper and height reporter", () => {
  const html = wrapUiSource("<div class='tabs'><button class='on'>Visão</button></div>");
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("frame-ancestors 'none'");
  expect(html).toContain("--accent:#c2603d");
  expect(html).toContain("ncliChart");
  expect(html).toContain("ncliUi");
  expect(html).toContain("ncli-ui");
  expect(html).toContain("ui-fill");
  expect(html).toContain('op==="layout"');
  expect(html).toContain("clientHeight");
  expect(html).toContain("body>section:not([hidden])");
  expect(html).not.toContain("cdn");
  expect(html).not.toContain("https://");
  expect(frameHtml({ kind: "ui", source: "<p>x</p>" })).toContain("ncliChart");
});

test("ui iframe is sandboxed, auto-keyed, and expand chrome stays in the parent", () => {
  const tag = iframeTag({ kind: "ui", source: DEMO_UI_SOURCE });
  expect(tag).toContain("ui-card");
  expect(tag).toContain("ui-expand");
  expect(tag).toContain(`data-ui-key="${uiKey(DEMO_UI_SOURCE)}"`);
  expect(tag).toContain("sandbox=\"allow-scripts\"");
  expect(tag).not.toContain("allow-same-origin");
  expect(tag).toContain("srcdoc=");
});

test("host messages accept height and send, reject junk", () => {
  expect(parseUiHostMsg({ type: "ncli-ui", op: "height", h: 240 })).toEqual({
    type: "ncli-ui",
    op: "height",
    h: 240,
  });
  expect(parseUiHostMsg({ type: "ncli-ui", op: "send", text: "  segue no plano B  " })).toEqual({
    type: "ncli-ui",
    op: "send",
    text: "segue no plano B",
  });
  expect(parseUiHostMsg({ type: "ncli-ui", op: "height", h: 0 })).toBeNull();
  expect(parseUiHostMsg({ type: "ncli-ui", op: "height", h: 9000 })).toBeNull();
  expect(parseUiHostMsg({ type: "ncli-ui", op: "send", text: "   " })).toBeNull();
  expect(parseUiHostMsg({ type: "ncli-ui", op: "send", text: "x".repeat(4001) })).toBeNull();
  expect(parseUiHostMsg({ type: "other", op: "send", text: "oi" })).toBeNull();
});

test("shimmer for ui is a card placeholder", () => {
  expect(liveShape("ui")).toBe("card");
  expect(liveLabel("ui")).toBe("montando o card…");
  const html = shimmerHtml("ui", DEMO_UI_SOURCE);
  expect(html).toContain("montando o card…");
  expect(html).not.toContain("<iframe");
});

test("ui fence persists in the log and still parses after reload", async () => {
  const dir = tmpDir("ui-log");
  const mem = new Memory({ dir, nodeBytes: 200, viewBytes: 800, compressor: mockCompressor() });
  mem.append({ kind: "talk", text: `Aqui.\n\n${demoUiFence()}`, seat: "claude" });
  const again = new Memory({ dir, nodeBytes: 200, viewBytes: 800, compressor: mockCompressor() });
  const talk = again.log.find((m) => m.kind === "talk" && m.text.includes("```ncli ui"));
  expect(talk).toBeDefined();
  expect(liveBlocks(talk!.text).map((b) => b.kind)).toEqual(["ui"]);
  expect(talk!.text).toContain("ncliChart");
});

test("client chat parser stays in lockstep with the ui kind", () => {
  const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  expect(js).toContain("mermaid|html|react|url|ui");
  expect(js).toContain("ncliChart");
  expect(js).toContain('op === "send"');
  expect(js).toContain("ui-expand");
  expect(js).toContain("function liveDocCss");
  expect(js).toContain("signalLayout");
  expect(js).toContain('op: "layout"');
  expect(css).toContain("body.ui-open .composer");
  expect(css).toContain("--ui-pane-w");
  expect(css).toContain("height: 100% !important");
});

test("assembled prompt and demo conversation teach the ui contract", async () => {
  const mem = new Memory({
    dir: tmpDir("ui-sys"),
    nodeBytes: 80,
    viewBytes: 400,
    compressor: mockCompressor(),
  });
  mem.append({ kind: "note", text: "oi" });
  const ctx = assemble(mem);
  expect(ctx.system).toContain("ncli/skills/ncli-ui/SKILL.md");
  expect(ctx.system).toContain("```ncli mermaid|html|react|url|ui");

  const { hub } = await makeHub({ demo: true });
  const talk = hub.memory.log.find((m) => m.kind === "talk" && m.text.includes("```ncli ui"));
  expect(talk).toBeDefined();
  expect(liveBlocks(talk!.text)[0]?.kind).toBe("ui");
  const forkTalk = hub.forks.list().some((f) => f.view === "live");
  expect(forkTalk).toBe(true);
  hub.close();
});
