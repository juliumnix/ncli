import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../public/app.css"), "utf8");
const js = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");

test("overlay and drawer enter and exit through a class, not instant hidden", () => {
  expect(js).toContain("function waitMotion");
  expect(js).toContain("function followScroll");
  expect(js).toContain('overlay.classList.add("in")');
  expect(js).toContain("waitMotion(overlay)");
  expect(js).toContain("waitMotion(d)");
  expect(js).not.toMatch(/function hideOverlay\(\) \{\s*overlay\.hidden = true/);
  expect(js).not.toMatch(/function setDrawer\(open\) \{\s*[^}]*d\.hidden = !open/);
});

test("motion CSS is transform/opacity, ease-out, and honors reduced motion", () => {
  expect(css).toContain("--ease-drawer");
  expect(css).toContain(".overlay.in");
  expect(css).toContain(".drawer.in");
  expect(css).toContain(".ch.out");
  expect(css).toMatch(/\.m\.enter/);
  expect(css).not.toMatch(/transition:\s*all\b/);
  expect(css).not.toMatch(/scale\(0\)/);
  expect(css.replace(/ease-in-out/g, "")).not.toMatch(/ease-in\b/);
  const reduce = css.split("@media (prefers-reduced-motion: reduce)");
  expect(reduce.length).toBeGreaterThan(1);
  expect(reduce[1]).toContain(".overlay");
  expect(reduce[1]).toContain(".drawer");
});
