import { expect, test } from "bun:test";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  announceReady,
  formatReady,
  noOpen,
  openCommand,
  openReadyBrowser,
  readyUrl,
  shouldOpenBrowser,
} from "../src/boot-ready";
import { tmpDir } from "./helpers";

test("formatReady names localhost and detected CLIs", () => {
  expect(readyUrl(47231)).toBe("http://localhost:47231");
  expect(formatReady({
    url: "http://localhost:47231",
    clis: { claude: true, codex: false, cursor: true },
  })).toBe("NCLI rodando em http://localhost:47231\nclis  claude ok, codex missing, cursor ok");
});

test("shouldOpenBrowser honors NCLI_NO_OPEN and a prior open", () => {
  expect(shouldOpenBrowser({}, false)).toBe(true);
  expect(shouldOpenBrowser({ NCLI_NO_OPEN: "1" }, false)).toBe(false);
  expect(shouldOpenBrowser({ NCLI_NO_OPEN: "true" }, false)).toBe(false);
  expect(shouldOpenBrowser({}, true)).toBe(false);
  expect(noOpen({ NCLI_NO_OPEN: "1" })).toBe(true);
});

test("openCommand uses the platform browser helper", () => {
  expect(openCommand("http://localhost:47231", "darwin")).toEqual(["open", "http://localhost:47231"]);
  expect(openCommand("http://localhost:47231", "linux")).toEqual(["xdg-open", "http://localhost:47231"]);
});

test("openReadyBrowser opens once and writes the marker", () => {
  const dataDir = tmpDir("open-once");
  const spawned: string[][] = [];
  expect(openReadyBrowser({
    url: "http://localhost:47231",
    dataDir,
    env: {},
    spawn: (cmd) => spawned.push(cmd),
  })).toBe(true);
  expect(spawned).toEqual([openCommand("http://localhost:47231")]);
  expect(existsSync(join(dataDir, "browser-opened"))).toBe(true);
  expect(readFileSync(join(dataDir, "browser-opened"), "utf8")).toContain("T");
  expect(openReadyBrowser({
    url: "http://localhost:47231",
    dataDir,
    env: {},
    spawn: (cmd) => spawned.push(cmd),
  })).toBe(false);
  expect(spawned).toHaveLength(1);
});

test("openReadyBrowser stays closed when NCLI_NO_OPEN is set", () => {
  const dataDir = tmpDir("no-open");
  expect(openReadyBrowser({
    url: "http://localhost:47231",
    dataDir,
    env: { NCLI_NO_OPEN: "1" },
    spawn: () => {
      throw new Error("should not open");
    },
  })).toBe(false);
  expect(existsSync(join(dataDir, "browser-opened"))).toBe(false);
});

test("announceReady writes the ready line with a sync flush", () => {
  const path = join(tmpDir("flush"), "out.txt");
  const handle = openSync(path, "w");
  announceReady({ url: "http://localhost:9", clis: { claude: false, codex: false, cursor: false } }, handle);
  closeSync(handle);
  expect(readFileSync(path, "utf8")).toBe(
    "NCLI rodando em http://localhost:9\nclis  claude missing, codex missing, cursor missing\n",
  );
});
