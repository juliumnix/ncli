import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bunBelowMin, bunVersionWarning, formatMinBun, parseBunVersion } from "../src/bun-version";

test("bun 1.3.3 is below 1.4.3 and 1.4.3 is not", () => {
  expect(parseBunVersion("1.3.3")).toEqual({ major: 1, minor: 3, patch: 3 });
  expect(bunBelowMin("1.3.3")).toBe(true);
  expect(bunBelowMin("1.4.2")).toBe(true);
  expect(bunBelowMin("1.4.3")).toBe(false);
  expect(bunBelowMin("1.5.0")).toBe(false);
  expect(bunVersionWarning("1.3.3")).toContain("1.3.3");
  expect(bunVersionWarning("1.3.3")).toContain(formatMinBun());
  expect(bunVersionWarning("1.4.3")).toBeUndefined();
});

test("package.json engines.bun requires 1.4.3", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { engines?: { bun?: string } };
  expect(pkg.engines?.bun).toBe(">=1.4.3");
});
