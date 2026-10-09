import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("drawer ships the OptMem list and raw toggle, not a default pre dump", () => {
  const html = readFileSync(join(import.meta.dir, "../public/index.html"), "utf8");
  const css = readFileSync(join(import.meta.dir, "../public/app.css"), "utf8");
  const js = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  expect(html).toContain('id="ctxList"');
  expect(html).toContain('id="ctxCascade"');
  expect(html).toContain('id="ctxRaw"');
  expect(html).toContain('id="debugView" hidden');
  expect(css).toContain(".ctx-badge");
  expect(css).toContain("ctx-flash");
  expect(css).toContain("prefers-reduced-motion");
  expect(js).toContain('case "context"');
  expect(js).toContain("Trabalhou por");
  expect(js).toContain("Lendo o projeto");
});
