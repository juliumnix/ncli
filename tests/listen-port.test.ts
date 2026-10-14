import { expect, test } from "bun:test";
import { bootNcli } from "../src/boot";
import { busyPortMessage, isAddrInUse, listenCandidates, nextPorts, portPinned } from "../src/listen-port";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, shotsDir, waitUntil } from "./helpers";
import { mkdirSync, writeFileSync } from "node:fs";

test("portPinned is only true when NCLI_PORT is set", () => {
  expect(portPinned({})).toBe(false);
  expect(portPinned({ NCLI_PORT: "47231" })).toBe(true);
  expect(nextPorts(47231, 3)).toEqual([47231, 47232, 47233]);
  expect(listenCandidates(0, false)).toEqual([0]);
  expect(listenCandidates(47231, true)).toEqual([47231]);
  expect(listenCandidates(47231, false).at(-1)).toBe(0);
  expect(isAddrInUse(Object.assign(new Error("Failed to start server. Is port 47231 in use?"), { code: "EADDRINUSE" }))).toBe(true);
  expect(isAddrInUse(new Error("Failed to start server. Is port 47231 in use?"))).toBe(true);
  expect(busyPortMessage(47231)).toBe("A porta 47231 está ocupada. Feche o outro NCLI ou use NCLI_PORT=47232.");
});

test("a pinned busy port throws a short message", async () => {
  const blocker = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const { hub } = await makeHub();
  hub.cfg.port = blocker.port;
  const prev = process.env.NCLI_PORT;
  process.env.NCLI_PORT = String(blocker.port);
  try {
    await expect(bootNcli({ cfg: hub.cfg, hub, root: process.cwd() })).rejects.toThrow(
      `A porta ${blocker.port} está ocupada`,
    );
  } finally {
    if (prev === undefined) delete process.env.NCLI_PORT;
    else process.env.NCLI_PORT = prev;
    blocker.stop(true);
    hub.close();
  }
});

test("an unpinned busy port takes the next free one", async () => {
  const blocker = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const { hub } = await makeHub();
  hub.cfg.port = blocker.port;
  const prev = process.env.NCLI_PORT;
  delete process.env.NCLI_PORT;
  try {
    const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
    try {
      expect(booted.server.port).not.toBe(blocker.port);
      expect(booted.server.port).toBeGreaterThan(0);
      expect(booted.report.revision.length).toBeGreaterThanOrEqual(7);
      const page = await fetch(booted.report.uiUrl);
      expect(page.ok).toBe(true);
    } finally {
      booted.stop();
    }
  } finally {
    if (prev !== undefined) process.env.NCLI_PORT = prev;
    else delete process.env.NCLI_PORT;
    blocker.stop(true);
    hub.close();
  }
});

test("chrome: fallback port still paints welcome", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const blocker = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const { hub } = await makeHub();
  hub.cfg.port = blocker.port;
  const prev = process.env.NCLI_PORT;
  delete process.env.NCLI_PORT;
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(9800 + Math.floor(Math.random() * 400));
  try {
    expect(booted.server.port).not.toBe(blocker.port);
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.querySelector(".welcome"))`),
      8000,
      "welcome",
    );
    const shots = shotsDir();
    mkdirSync(shots, { recursive: true });
    writeFileSync(`${shots}/bunx-fresh-port.png`, await driver.session.screenshot());
  } finally {
    driver.close();
    booted.stop();
    blocker.stop(true);
    hub.close();
    if (prev !== undefined) process.env.NCLI_PORT = prev;
    else delete process.env.NCLI_PORT;
  }
}, 30000);
