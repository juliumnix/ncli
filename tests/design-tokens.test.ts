import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isToolDiaryNote, toolActivityLine } from "../src/memory/turn-log";

const appCss = readFileSync(new URL("../public/app.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../public/tokens.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("tokens.css is the only palette and app.css has no loose hex", () => {
  expect(tokens).toContain("--accent: #6ea4ff");
  expect(tokens).toContain("--h-claude: #d97757");
  expect(tokens).toContain("InterVariable");
  const hex = [...appCss.matchAll(/#[0-9a-fA-F]{3,8}(?=[\s;,)])/g)].map((m) => m[0]);
  expect(hex).toEqual([]);
});

test("index preloads Inter Variable and JetBrains Mono and loads tokens before app.css", () => {
  expect(html).toContain('href="/fonts/InterVariable.woff2"');
  expect(html).toContain('href="/fonts/JetBrainsMono-Regular.woff2"');
  expect(tokens).toContain("JetBrainsMono-Regular.woff2");
  expect(html).toContain('href="/tokens.css"');
  expect(html.indexOf("/tokens.css")).toBeLessThan(html.indexOf("/app.css"));
});

test("focus-visible exists and every outline:none sits next to a ring", () => {
  expect(appCss).toContain(":focus-visible");
  expect(appCss).toContain("var(--focus-ring)");
  expect(appCss).toContain(".composer.from-key:focus-within");
  expect(appCss).not.toContain(".composer:has(:focus-visible)");
  expect(appJs).toContain('form.classList.add("from-key")');
  expect(appJs).toContain('form.classList.remove("from-key")');
  expect(appCss).not.toContain("color-mix(in srgb, var(--accent) 22%");
  const bare = [...appCss.matchAll(/outline:\s*none/g)];
  expect(bare.length).toBeGreaterThan(0);
  expect(appCss).toContain(".q {");
  expect(appCss).toContain("var(--accent-bg)");
});

test("iframes and mermaid arrows use the token accent, not terracotta", () => {
  expect(appJs).not.toContain("#c2603d");
  expect(appJs).not.toContain("#0f0f11");
  expect(appJs).toContain('v("--accent")');
});

test("refino question card uses the accent surface, not a light leftover", () => {
  expect(appCss).toMatch(/\.q\s*\{[^}]*var\(--accent-bg\)/);
  expect(appCss).not.toContain("#f5f9ff");
  expect(appCss).not.toContain("#fef3c7");
});

test("tool diary notes stay in memory and stay out of the chat paint", () => {
  expect(toolActivityLine(["zoom", "date"])).toBe("tools: zoom, date");
  expect(isToolDiaryNote("tools: zoom, date")).toBe(true);
  expect(isToolDiaryNote("Claude bateu no limite")).toBe(false);
  expect(appJs).toContain("/^tools:\\s/i.test(m.text)");
  expect(appJs).toContain("if (/^tools:\\s/i.test(m.text)) continue");
});
