import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { iframeTag, mermaidNodes, renderLive } from "../src/live/frame";
import { assemble } from "../src/memory/assemble";
import { Memory, mockCompressor } from "../src/memory/store";
import { liveBlocks, parseLive } from "../src/live/parse";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, shotsDir, tmpDir, waitUntil } from "./helpers";

const NESTED_CODEX = `aqui o diagrama\n\n\`\`\`ncli ui\n\`\`\`mermaid\nflowchart TD\n  hub[Hub] --> ui[Chat]\n\`\`\`\n\`\`\``;
const BARE_MERMAID = `\`\`\`mermaid\nflowchart LR\n  a[Entrada] --> b[Índice]\n\`\`\``;
const FLOW_SEATS = ["claude", "codex", "cursor"] as const;
const DESK_LABELS = /Tampo|Grampo|mesa/i;

function graphFenceFor(topic: string): string {
  const nodes = topic.split(/\s*[·>|→-]+\s*/).map((label, i) => ({
    id: `n${i}`,
    label: label.replace(/[^\p{L}\p{N} ]/gu, "").trim() || `n${i}`,
  })).filter((n) => n.label);
  const edges = nodes.slice(1).map((n, i) => [nodes[i]!.id, n.id]);
  const layers = nodes.map((n) => [n.id]);
  return `\`\`\`ncli 3d\nncli3d.graph(${JSON.stringify({ nodes, edges, layers })})\n\`\`\``;
}

test("Codex nested mermaid-in-ui and bare mermaid become a diagram, never an empty card", () => {
  expect(liveBlocks(NESTED_CODEX).map((b) => b.kind)).toEqual(["mermaid"]);
  expect(liveBlocks(NESTED_CODEX)[0]?.source).toContain("Hub");
  expect(liveBlocks(BARE_MERMAID)[0]).toEqual({
    kind: "mermaid",
    source: "flowchart LR\n  a[Entrada] --> b[Índice]",
  });
  expect(parseLive("```ncli ui\n```").some((s) => s.type === "live" && s.block.kind === "ui" && !s.block.source)).toBe(true);
  const empty = renderLive({ kind: "ui", source: "" });
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.error).toMatch(/vazia|fence/i);
  expect(iframeTag({ kind: "ui", source: "" })).toContain("live-err");
  expect(iframeTag({ kind: "ui", source: "" })).toContain("não deu para renderizar");
  expect(iframeTag({ kind: "mermaid", source: "not a graph" })).toContain("diagrama sem nós");
  expect(mermaidNodes("flowchart TD\nA[um] --> B[dois]").get("A")).toBe("um");
});

test("live shell and frames inherit the dark theme; skill teaches three seats and graph", () => {
  const origin = readFileSync(new URL("../src/live/origin.ts", import.meta.url), "utf8");
  expect(origin).toContain("color-scheme:dark");
  expect(origin).toContain("background:#0f0f11");
  expect(origin).toContain("ncliFail");
  expect(origin).not.toContain("catch(e){}");
  const css = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
  expect(css).toContain("color-scheme: dark");
  const skill = readFileSync(new URL("../ncli/skills/ncli-ui/SKILL.md", import.meta.url), "utf8");
  expect(skill).toContain("Claude, Codex, and Cursor");
  expect(skill).toContain("```ncli mermaid");
  expect(skill).toContain("```ncli ui");
  expect(skill).toContain("```ncli 3d");
  expect(skill).toContain("ncli3d.graph");
  expect(skill).not.toContain("ncli3d.desk()");
  expect(skill).not.toContain("Tampo");
  expect(skill).not.toContain("Grampo");
  expect(skill).toContain("Do not nest");
  const kit = readFileSync(new URL("../public/ncli3d.js", import.meta.url), "utf8");
  expect(kit).toContain("function graph");
  expect(kit).toContain("showError");
  expect(kit).not.toMatch(/if \(!document.querySelector\("canvas"\)\) desk\(\)/);
  const mem = new Memory({ dir: tmpDir("ui-3d-sys"), nodeBytes: 80, viewBytes: 400, compressor: mockCompressor() });
  mem.append({ kind: "note", text: "oi" });
  const ctx = assemble(mem);
  expect(ctx.system).toContain("ncli3d.graph");
  expect(ctx.system).not.toMatch(DESK_LABELS);
  expect(ctx.system).not.toContain("ncli3d.desk");
});

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function pngHasNonWhite(buf: Uint8Array, max = 248): boolean {
  if (buf[1] !== 0x50) throw new Error("not png");
  let off = 8;
  let w = 0;
  let h = 0;
  const chunks: Buffer[] = [];
  const src = Buffer.from(buf);
  while (off + 12 <= src.length) {
    const len = src.readUInt32BE(off);
    const typ = src.toString("ascii", off + 4, off + 8);
    const data = src.subarray(off + 8, off + 8 + len);
    if (typ === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
    }
    if (typ === "IDAT") chunks.push(Buffer.from(data));
    if (typ === "IEND") break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let i = 0;
  let o = 0;
  for (let y = 0; y < h; y++) {
    const type = raw[i++] ?? 0;
    for (let x = 0; x < stride; x++) {
      const cur = raw[i++] ?? 0;
      const a = x >= bpp ? out[o + x - bpp]! : 0;
      const b = y > 0 ? out[o + x - stride]! : 0;
      const c = y > 0 && x >= bpp ? out[o + x - stride - bpp]! : 0;
      let val = cur;
      if (type === 1) val = (cur + a) & 255;
      else if (type === 2) val = (cur + b) & 255;
      else if (type === 3) val = (cur + Math.floor((a + b) / 2)) & 255;
      else if (type === 4) val = (cur + paeth(a, b, c)) & 255;
      out[o + x] = val;
    }
    o += stride;
  }
  for (let p = 0; p < out.length; p += 4) {
    if ((out[p] ?? 255) < max || (out[p + 1] ?? 255) < max || (out[p + 2] ?? 255) < max) return true;
  }
  return false;
}

test("chrome: mermaid from Claude, Codex, and Cursor paints non-white pixels", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  for (const seat of FLOW_SEATS) {
    hub.memory.append({
      kind: "talk",
      seat,
      text: `${seat}\n\n\`\`\`ncli mermaid\nflowchart TD\n  ${seat}[Seat ${seat}] --> log[log.jsonl]\n\`\`\``,
    });
  }
  hub.memory.append({ kind: "talk", seat: "codex", text: NESTED_CODEX });
  hub.cfg.port = 0;
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: join(import.meta.dir, "..") });
  const driver = await launchChrome(24000 + (Date.now() % 8000));
  const shots = shotsDir();
  mkdirSync(shots, { recursive: true });
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`document.querySelectorAll(".live-frame, .live-err").length >= 3`),
      15000,
      "live frames",
    );
    const facts = await driver.session.evaluate<{
      errs: number;
      frames: number;
      scheme: string;
      bg: string;
    }>(`(() => {
      const frame = document.querySelector(".live-frame");
      const cs = frame ? getComputedStyle(frame) : null;
      return {
        errs: document.querySelectorAll(".live-err").length,
        frames: document.querySelectorAll(".live-frame").length,
        scheme: cs ? cs.colorScheme : "",
        bg: cs ? cs.backgroundColor : "",
      };
    })()`);
    expect(facts.frames).toBeGreaterThanOrEqual(3);
    expect(facts.bg).not.toMatch(/255,\s*255,\s*255/);
    const box = await driver.session.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => {
      const el = document.querySelector(".live-frame, .live-err");
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
    const shot = await driver.session.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      clip: { x: box.x, y: box.y, width: Math.max(8, box.width), height: Math.max(8, box.height), scale: 1 },
      fromSurface: true,
    });
    const png = Buffer.from(shot.data, "base64");
    writeFileSync(join(shots, "ncli-ui-mermaid.png"), png);
    expect(pngHasNonWhite(png)).toBe(true);
  } finally {
    driver.close();
    booted.stop();
    hub.close();
  }
}, 40000);

test("chrome: 3d graph for a real topic never shows desk labels", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const topic = "Cockpit v2 · Hub → Chat → Memory";
  const fence = graphFenceFor(topic);
  expect(fence).toContain("Cockpit");
  expect(fence).not.toMatch(DESK_LABELS);
  const { hub } = await makeHub();
  for (const seat of FLOW_SEATS) {
    hub.memory.append({
      kind: "talk",
      seat,
      text: `${seat} · ${topic}\n\n${fence}`,
    });
  }
  hub.cfg.port = 0;
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: join(import.meta.dir, "..") });
  const driver = await launchChrome(25000 + (Date.now() % 8000));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () =>
        driver.session.evaluate(`(() => {
          const frames = [...document.querySelectorAll("iframe.live-3d")];
          return frames.some((f) => f.dataset.ncli3dKind === "graph" || Number(f.dataset.ncli3dTris || 0) > 0);
        })()`),
      15000,
      "3d graph",
    );
    const facts = await driver.session.evaluate<{ n: number; labels: string }>(`(() => {
      const frames = [...document.querySelectorAll("iframe.live-3d")];
      return { n: frames.length, labels: frames.map((f) => f.dataset.ncli3dBtns || f.dataset.ncli3dKind || "").join("|") };
    })()`);
    expect(facts.n).toBe(FLOW_SEATS.length);
    expect(facts.labels).not.toMatch(DESK_LABELS);
    expect(facts.labels).toMatch(/Hub|Cockpit|Chat|Memory|graph/i);
  } finally {
    driver.close();
    booted.stop();
    hub.close();
  }
}, 40000);
