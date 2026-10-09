import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("markdown bubbles do not share the modal max-height rule", () => {
  const css = readFileSync(join(import.meta.dir, "../public/app.css"), "utf8");
  expect(css).not.toMatch(/\.modal\s*,\s*\.md\b/);
  expect(css).toContain("max-height: none");
  const html = readFileSync(join(import.meta.dir, "../public/index.html"), "utf8");
  expect(html).toContain('class="scroller"');
  expect(html).toContain('id="log"');
});
