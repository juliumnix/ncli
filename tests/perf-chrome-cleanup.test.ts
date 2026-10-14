import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake "chrome": serves /json/version + a websocket on the debug port, writes
// into --user-data-dir like Chrome does, and logs the profile path for the test.
const work = mkdtempSync(join(tmpdir(), "ncli-cdp-cleanup-test-"));
const log = join(work, "profiles.log");
const fakeOk = join(work, "fake-chrome.ts");
const fakeDead = join(work, "fake-dead-chrome.ts");
writeFileSync(
  fakeOk,
  `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
const arg = (k) => process.argv.find((a) => a.startsWith(k))?.slice(k.length);
const port = Number(arg("--remote-debugging-port="));
const profile = arg("--user-data-dir=");
appendFileSync(${JSON.stringify(log)}, profile + "\\n");
writeFileSync(profile + "/Local State", "{}");
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/browser" });
  },
  websocket: { message() {} },
});
`,
);
writeFileSync(
  fakeDead,
  `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
const profile = process.argv.find((a) => a.startsWith("--user-data-dir="))!.slice(16);
appendFileSync(${JSON.stringify(log)}, profile + "\\n");
writeFileSync(profile + "/Local State", "{}");
await Bun.sleep(60_000);
`,
);
chmodSync(fakeOk, 0o755);
chmodSync(fakeDead, 0o755);

const lastProfile = () => readFileSync(log, "utf8").trim().split("\n").at(-1)!;
const port = () => 15000 + Math.floor(Math.random() * 2000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("launchChrome profile cleanup", () => {
  test("removes the profile dir after a successful run closes", async () => {
    process.env.NCLI_PERF_CHROME = fakeOk;
    const { launchChrome } = await import("../src/perf/cdp");
    const driver = await launchChrome(port());
    expect(existsSync(driver.profile)).toBe(true);
    await driver.close();
    expect(existsSync(driver.profile)).toBe(false);
  });

  test("removes the profile dir when the launch fails", async () => {
    process.env.NCLI_PERF_CHROME = fakeDead;
    const { launchChrome } = await import("../src/perf/cdp");
    await expect(launchChrome(port(), [], { bootTimeoutMs: 400 })).rejects.toThrow();
    expect(existsSync(lastProfile())).toBe(false);
  });

  test("removes the profile dir when the run throws inside try/finally", async () => {
    process.env.NCLI_PERF_CHROME = fakeOk;
    const { launchChrome } = await import("../src/perf/cdp");
    let profile = "";
    await expect(
      (async () => {
        const driver = await launchChrome(port());
        profile = driver.profile;
        try {
          throw new Error("scenario failed");
        } finally {
          await driver.close();
        }
      })(),
    ).rejects.toThrow("scenario failed");
    expect(existsSync(profile)).toBe(false);
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    test(`removes the profile dir when the perf process gets ${sig}`, async () => {
      const runner = join(work, `runner-${sig}.ts`);
      writeFileSync(
        runner,
        `import { launchChrome } from ${JSON.stringify(join(import.meta.dir, "../src/perf/cdp"))};
await launchChrome(${port()});
console.log("ready");
await Bun.sleep(60_000);
`,
      );
      const child = Bun.spawn([process.execPath, runner], {
        env: { ...process.env, NCLI_PERF_CHROME: fakeOk },
        stdout: "pipe",
        stderr: "inherit",
      });
      const reader = child.stdout.getReader();
      let out = "";
      while (!out.includes("ready")) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      const profile = lastProfile();
      expect(existsSync(profile)).toBe(true);
      child.kill(sig);
      await child.exited;
      expect(existsSync(profile)).toBe(false);
    }, 20_000);
  }
});
