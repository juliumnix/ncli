import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  documentedBunx,
  documentedLaunch,
  ncliSpecAt,
  parseLsRemoteMain,
  parseRevision,
  parseShaFromPath,
  resolveRevision,
  shortSha,
} from "../src/revision";
import { tmpDir } from "./helpers";

const MAIN = "b5f42a699b4a33960f49a13a2d4a6761a7477dbd";

test("ncliSpecAt pins github:juliumnix/ncli to a main SHA", () => {
  expect(ncliSpecAt("b5f42a6abc")).toBe("github:juliumnix/ncli#b5f42a6abc");
  expect(documentedBunx("b5f42a6abc")).toEqual(["bunx", "github:juliumnix/ncli#b5f42a6abc"]);
  expect(documentedLaunch("b5f42a6abc")).toEqual({
    env: { NCLI_REVISION: "b5f42a6abc" },
    argv: ["bunx", "github:juliumnix/ncli#b5f42a6abc"],
  });
  expect(() => ncliSpecAt("main")).toThrow(/commit sha/);
});

test("parseLsRemoteMain reads the main tip", () => {
  const text = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa	HEAD",
    `${MAIN}	refs/heads/main`,
    "cccccccccccccccccccccccccccccccccccccccc	refs/heads/old",
  ].join("\n");
  expect(parseLsRemoteMain(text)).toBe(MAIN);
  expect(shortSha(parseLsRemoteMain(text))).toBe("b5f42a6");
  expect(parseShaFromPath(`/home/u/.bun/install/cache/github.com/juliumnix/ncli@${MAIN}/src`)).toBe(MAIN);
});

test("resolveRevision prefers env, then file, then git", () => {
  const root = tmpDir("rev");
  expect(parseRevision("deadbee")).toEqual({ sha: "deadbee", short: "deadbee" });
  expect(resolveRevision(root, { NCLI_REVISION: "cafebab123" }).short).toBe("cafebab");
  writeFileSync(join(root, ".ncli-revision"), `${MAIN}\n`);
  expect(resolveRevision(root, {}).short).toBe("b5f42a6");
});

test("resolveRevision reads a bunx cache path when git is missing", () => {
  const root = join(tmpDir("rev-path"), MAIN);
  mkdirSync(root, { recursive: true });
  expect(resolveRevision(root, {}).sha).toBe(MAIN);
});
