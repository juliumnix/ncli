import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatPaintFor } from "../src/live/chat-patch";

test("token and step events paint only the live turn while a turn is running", () => {
  expect(chatPaintFor("delta", true)).toBe("live");
  expect(chatPaintFor("step", true)).toBe("live");
  expect(chatPaintFor("turn", true)).toBe("live");
  expect(chatPaintFor("hello", true)).toBe("full");
  expect(chatPaintFor("message", false)).toBe("full");
  expect(chatPaintFor("turn", false)).toBe("full");
  expect(chatPaintFor("main", true)).toBe("chrome");
});

test("chat CSS uses content-visibility and transform/opacity motion only on stream chrome", () => {
  const css = readFileSync(join(import.meta.dir, "../public/app.css"), "utf8");
  expect(css).toContain("content-visibility: auto");
  expect(css).toContain(".live-answer .chunk");
  expect(css).not.toMatch(/\.live-answer \.chunk\s*\{[^}]*animation:/);
  const js = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  expect(js).toContain("requestAnimationFrame");
  expect(js).toContain("paintLive");
  expect(js).toContain("mdMemo");
  expect(js).toContain("Consultando o Codex");
  expect(js).not.toMatch(/cursor\|ask\|wait\|bus/);
});
