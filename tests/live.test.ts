import { expect, test } from "bun:test";
import { join } from "node:path";
import { frameHtml, iframeTag, jsxLite, mermaidSvg, safeUrl } from "../src/live/frame";
import { liveBlocks, parseLive, renderToolToFence } from "../src/live/parse";
import { ViewRegistry } from "../src/views/registry";
import live from "../views/live";
import { makeHub } from "./helpers";

test("parseLive splits ncli fences and leaves surrounding text", () => {
  const text = `Fluxo.\n\n\`\`\`ncli mermaid\ngraph TD\nA --> B\n\`\`\`\n\ne o card\n\n\`\`\`ncli html\n<div>ok</div>\n\`\`\``;
  const segs = parseLive(text);
  expect(segs[0]).toEqual({ type: "text", text: "Fluxo.\n\n" });
  expect(segs[1]).toEqual({ type: "live", block: { kind: "mermaid", source: "graph TD\nA --> B" } });
  expect(liveBlocks(text).map((b) => b.kind)).toEqual(["mermaid", "html"]);
  expect(renderToolToFence("react", "<Box/>")).toBe("```ncli react\n<Box/>\n```");
});

test("mermaid becomes an inline SVG (no CDN) and html/react/url go through a sandboxed iframe", () => {
  const svg = mermaidSvg("graph TD\nA[subtotal] --> B[desconto]\nB --> C[total]");
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg).toContain("subtotal");
  expect(svg).toContain("desconto");
  expect(svg).not.toContain("cdn");
  const html = iframeTag({ kind: "html", source: "<b>card</b>" });
  expect(html).toContain("sandbox=\"allow-scripts\"");
  expect(html).not.toContain("allow-same-origin");
  expect(html).toContain("srcdoc=");
  expect(html).toContain("Content-Security-Policy");
  expect(frameHtml({ kind: "html", source: "<p>x</p>" })).toContain("default-src 'none'");
  const pickup = frameHtml({ kind: "html", source: "<b>Pickup scheduling</b><p>customer picks a slot</p>" });
  expect(pickup).toContain("--fg:#ececec");
  expect(pickup).toContain("color:var(--fg)");
  expect(pickup).toContain("background:var(--bg)");
  expect(jsxLite(`function Card() {\n  return (\n    <div className="card">ok</div>\n  );\n}`)).toContain('class="card"');
});

test("url previews only allow http(s)", () => {
  expect(safeUrl("https://example.com")).toBe("https://example.com/");
  expect(safeUrl("http://127.0.0.1:9")).toBe("http://127.0.0.1:9/");
  expect(safeUrl("javascript:alert(1)")).toBeNull();
  expect(safeUrl("file:///etc/passwd")).toBeNull();
  expect(iframeTag({ kind: "url", source: "javascript:alert(1)" })).toContain("url bloqueada");
});

test("view://live holds five sandboxed previews and stays on the waiting rail", async () => {
  const { hub } = await makeHub();
  const rt = await hub.forks.open("live", {});
  expect(rt.fork.hold).toBe(true);
  expect(rt.fork.needsUser?.label).toBe("5 prévias");
  expect(hub.forks.waitingOnUser().some((f) => f.id === rt.fork.id)).toBe(true);
  const html = live.render!(rt.fork);
  expect(html).toContain("live-frame");
  expect(html).toContain("MERMAID");
  expect(html).toContain("HTML");
  expect(html).toContain("REACT");
  expect(html).toContain("URL");
  expect(html).toContain("UI");
  expect(html).toContain("ui-card");
  expect(html).toContain("sandbox=");
  hub.close();
});

test("demo conversation includes live fences in chat", async () => {
  const { hub } = await makeHub({ demo: true });
  const talk = hub.memory.log.find((m) => m.kind === "talk" && m.text.includes("```ncli mermaid"));
  expect(talk).toBeDefined();
  expect(liveBlocks(talk!.text).map((b) => b.kind)).toEqual(["mermaid", "html"]);
  expect(hub.forks.list().some((f) => f.view === "live")).toBe(true);
  hub.close();
});

test("registry ships live alongside review and refino", async () => {
  const reg = new ViewRegistry(join(import.meta.dir, "../views"));
  await reg.loadAll();
  expect(reg.list().map((v) => v.id).sort()).toEqual(["live", "refino", "review"]);
});
