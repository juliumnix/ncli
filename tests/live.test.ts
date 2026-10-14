import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compartmentHtml } from "../src/live/compartment";
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
  expect(svg).toContain('x="16"');
  expect(svg).toContain('y="28"');
  expect(svg).not.toContain("cdn");
  const html = iframeTag({ kind: "html", source: "<b>card</b>" });
  expect(html).toContain('class="live-wrap in"');
  expect(html).toContain("sandbox=\"allow-scripts\"");
  expect(html).toContain("RTCPeerConnection");
  expect(html).not.toContain("allow-same-origin");
  expect(html.includes("srcdoc=") || html.includes("/shell#")).toBe(true);
  expect(html).toContain("Content-Security-Policy");
  expect(frameHtml({ kind: "html", source: "<p>x</p>" })).toContain("default-src 'none'");
  expect(frameHtml({ kind: "html", source: "<p>x</p>" })).toContain("form-action 'none'");
  expect(html).not.toContain("allow-forms");
  expect(html).not.toContain("allow-top-navigation");
  const pickup = frameHtml({ kind: "html", source: "<b>Pickup scheduling</b><p>customer picks a slot</p>" });
  expect(pickup).toContain("--fg:#eeeef0");
  expect(pickup).toContain("color:var(--fg)");
  expect(pickup).toContain("background:var(--bg)");
  expect(jsxLite(`function Card() {\n  return (\n    <div className="card">ok</div>\n  );\n}`)).toContain('class="card"');
});

test("live CSP meta stays inside head even if the body closes head", () => {
  const html = compartmentHtml("</head><body><h1>x</h1>", "<style>x{}</style>");
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  expect(head).toContain("Content-Security-Policy");
  expect(head).toContain("default-src 'none'");
  expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("</head>"));
  expect(html).not.toMatch(/<\/head>[\s\S]*Content-Security-Policy/);
  const origin = readFileSync(join(import.meta.dir, "../src/live/origin.ts"), "utf8");
  expect(origin).toContain('"content-security-policy": LIVE_DOC_CSP');
});

test("url previews only allow http(s)", () => {
  expect(safeUrl("https://example.com")).toBe("https://example.com/");
  expect(safeUrl("http://127.0.0.1:9")).toBe("http://127.0.0.1:9/");
  expect(safeUrl("javascript:alert(1)")).toBeNull();
  expect(safeUrl("file:///etc/passwd")).toBeNull();
  expect(iframeTag({ kind: "url", source: "javascript:alert(1)" })).toContain("url bloqueada");
  const ask = iframeTag({ kind: "url", source: "https://example.com" });
  expect(ask).toContain("live-url-go");
  expect(ask).toContain("https://example.com/");
  expect(ask).not.toContain("<iframe");
});

test("view://live holds six sandboxed previews and stays on the waiting rail", async () => {
  const { hub } = await makeHub();
  const rt = await hub.sparks.open("live", {});
  expect(rt.spark.hold).toBe(true);
  expect(rt.spark.needsUser?.label).toBe("6 prévias");
  expect(hub.sparks.waitingOnUser().some((f) => f.id === rt.spark.id)).toBe(true);
  const html = live.render!(rt.spark);
  expect(html).toContain("live-frame");
  expect(html).toContain("MERMAID");
  expect(html).toContain("HTML");
  expect(html).toContain("REACT");
  expect(html).toContain("URL");
  expect(html).toContain("UI");
  expect(html).toContain("3D");
  expect(html).toContain("live-3d");
  expect(html).toContain("ui-card");
  expect(html).toContain("sandbox=");
  hub.close();
});

test("demo conversation includes live fences in chat", async () => {
  const { hub } = await makeHub({ demo: true });
  const talk = hub.memory.log.find((m) => m.kind === "talk" && m.text.includes("```ncli mermaid"));
  expect(talk).toBeDefined();
  expect(liveBlocks(talk!.text).map((b) => b.kind)).toEqual(["mermaid", "html"]);
  expect(hub.sparks.list().some((f) => f.view === "live")).toBe(true);
  hub.close();
});

test("registry ships live alongside review and refino", async () => {
  const reg = new ViewRegistry(join(import.meta.dir, "../views"));
  await reg.loadAll();
  expect(reg.list().map((v) => v.id).sort()).toEqual(["live", "refino", "review", "team"]);
});
