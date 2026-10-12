import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { initTempRepo } from "../src/sparks/worktree";
import { makeHub, shotsDir, tmpDir, waitUntil } from "./helpers";

test("shotsDir defaults to tmp and is writable", () => {
  const dir = shotsDir({});
  expect(dir.startsWith(tmpdir())).toBe(true);
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, "probe.txt");
  writeFileSync(probe, "ok");
  expect(readFileSync(probe, "utf8")).toBe("ok");
});

test("shotsDir uses NCLI_SHOTS when set", () => {
  expect(shotsDir({ NCLI_SHOTS: "/tmp/ncli-custom-shots" })).toBe("/tmp/ncli-custom-shots");
  expect(shotsDir({ NCLI_SHOTS: "  /tmp/ncli-custom-shots  " })).toBe("/tmp/ncli-custom-shots");
  expect(shotsDir({ NCLI_SHOTS: "" }).startsWith(tmpdir())).toBe(true);
});

test("the package bin boots HTTP the way bunx would", async () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as {
    bin?: { ncli?: string };
  };
  expect(pkg.bin?.ncli).toBeTruthy();
  const file = join(import.meta.dir, "..", pkg.bin!.ncli!);
  const dataDir = tmpDir("bunx-data");
  const repo = await initTempRepo("bunx-repo");
  const port = 19100 + Math.floor(Math.random() * 400);
  const proc = Bun.spawn([process.execPath, file], {
    cwd: repo,
    env: {
      ...process.env,
      NCLI_HARNESS: "mock",
      NCLI_GH: "mock",
      NCLI_DATA: dataDir,
      NCLI_PORT: String(port),
      NCLI_REPO: repo,
      NCLI_NO_OPEN: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const dec = new TextDecoder();
  let out = "";
  const pump = (async () => {
    for await (const chunk of proc.stdout) out += dec.decode(chunk);
  })();
  try {
    await waitUntil(
      () => out.includes(`NCLI rodando em http://localhost:${port}`) && /\bclis\b/.test(out),
      8000,
      "boot banner",
    );
    const ui = await fetch(`http://127.0.0.1:${port}/`);
    expect(ui.ok).toBe(true);
    expect(await ui.text()).toContain("<title>NCLI</title>");
    expect(out).toContain("mcp");
  } finally {
    proc.kill();
    await proc.exited;
    await pump;
  }
});

test("install-progress flushes bunx install lines on stderr", () => {
  const script = join(import.meta.dir, "../scripts/install-progress.ts");
  const install = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  expect(install.exitCode).toBe(0);
  expect(install.stdout.toString()).toBe("");
  expect(install.stderr.toString()).toBe("NCLI: instalando dependências...\n");
  const done = Bun.spawnSync([process.execPath, script, "done"], { stdout: "pipe", stderr: "pipe" });
  expect(done.exitCode).toBe(0);
  expect(done.stderr.toString()).toBe("NCLI: instalado.\n");
});

test("chrome: bunx-equivalent boot shows the first-session welcome", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  hub.cfg.port = 19200 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(9700 + Math.floor(Math.random() * 400));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.querySelector(".welcome"))`),
      8000,
      "welcome",
    );
    const text = await driver.session.evaluate<string>(
      `document.querySelector(".welcome")?.textContent?.trim() || ""`,
    );
    expect(text).toContain("O mesmo Claude do CLI");
    const shots = shotsDir();
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, "bunx-welcome.png"), await driver.session.screenshot());
  } finally {
    driver.close();
    booted.stop();
  }
}, 30000);
