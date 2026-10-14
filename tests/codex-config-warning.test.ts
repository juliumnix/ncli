import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkCodexConfig, formatCodexConfigWarnings } from "../src/acp/codex";
import { tmpDir } from "./helpers";

test("checkCodexConfig reports a legacy profile and a stdio ncli server without echoing values", () => {
  const home = tmpDir("codex-warn");
  mkdirSync(home, { recursive: true });
  const path = join(home, "config.toml");
  const secret = "super-secret-model";
  const command = "old-ncli-binary";
  writeFileSync(
    path,
    [
      `profile = "release"`,
      ``,
      `[profiles.release]`,
      `model = "${secret}"`,
      ``,
      `[mcp_servers.other]`,
      `command = "fake-other"`,
      `args = ["serve"]`,
      ``,
      `[mcp_servers.ncli]`,
      `enabled = false`,
      `command = "${command}"`,
      `args = ["stdio"]`,
      ``,
    ].join("\n"),
  );
  const warnings = checkCodexConfig(path);
  expect(warnings.map((w) => w.code)).toEqual(["legacy-profile", "stdio-ncli"]);
  expect(warnings.every((w) => w.path.length > 0 && !w.path.startsWith("/"))).toBe(true);
  const text = formatCodexConfigWarnings(warnings);
  expect(text).toContain("legacy profile");
  expect(text).toContain("stdio");
  expect(text.includes(path)).toBe(false);
  expect(text.includes(home)).toBe(false);
  if (process.env.HOME) expect(text.includes(process.env.HOME)).toBe(false);
  expect(text).not.toContain(secret);
  expect(text).not.toContain(command);
  expect(text).not.toContain("release");
});

test("checkCodexConfig is quiet for an http ncli entry and a missing file", () => {
  const home = tmpDir("codex-ok");
  const path = join(home, "config.toml");
  writeFileSync(path, `[mcp_servers.ncli]\nenabled = false\nurl = "http://127.0.0.1:9/mcp"\n`);
  expect(checkCodexConfig(path)).toEqual([]);
  expect(checkCodexConfig(join(home, "missing.toml"))).toEqual([]);
});
