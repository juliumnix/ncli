import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("/dev lists the fixture states the audit asked for", () => {
  const html = readFileSync(new URL("../public/dev.html", import.meta.url), "utf8");
  expect(html).toContain("tokens.css");
  expect(html).toContain("vazio");
  expect(html).toContain("pensando");
  expect(html).toContain("streaming");
  expect(html).toContain("erro");
  expect(html).toContain("nomes longos");
  expect(html).toContain("lista enorme");
  expect(html).toContain("shimmer-text");
  expect(html).toContain("note warn");
  expect(html).toContain(".dev-block > h2");
  expect(html).not.toMatch(/\.dev-page h2\b/);
});
