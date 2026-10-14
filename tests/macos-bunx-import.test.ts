import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readGitHead } from "../src/revision";

test("a bunx extract boot imports a large Claude history and prints the sha", async () => {
  const repo = join(import.meta.dir, "..");
  const sha = readGitHead(repo);
  expect(sha).toBeTruthy();
  const ran = Bun.spawnSync([process.execPath, join(repo, "scripts/macos-bunx-import.ts")], {
    cwd: repo,
    env: { ...process.env, NCLI_REVISION: sha, NCLI_COMPACT: "mock", NCLI_HARNESS: "mock" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  });
  const err = `${ran.stdout.toString()}${ran.stderr.toString()}`;
  expect(ran.exitCode, err).toBe(0);
}, 180000);

test("macos CI launches the same probe through bunx github:juliumnix/ncli#sha", () => {
  const yml = readFileSync(join(import.meta.dir, "../.github/workflows/macos-import.yml"), "utf8");
  expect(yml).toContain("macos-latest");
  expect(yml).toContain('"1.3.3"');
  expect(yml).toContain('"1.4.3"');
  expect(yml).toContain("scripts/macos-bunx-import.ts --bunx");
  const script = readFileSync(join(import.meta.dir, "../scripts/macos-bunx-import.ts"), "utf8");
  expect(script).toContain('["bunx", ncliSpecAt(pin)]');
  expect(script).toContain("readyBannerSha(pin, live)");
  expect(script).toContain("NCLI_REVISION: pin");
  expect(script).toContain(".ncli-revision");
  expect(script).toContain("FILES = 66");
  expect(script).toContain("LINES = 100");
  expect(script).toContain("first.kill()");
});
