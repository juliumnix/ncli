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
  readGitHead,
  resolveRevision,
  shortSha,
} from "../src/revision";
import { initTempRepo } from "../src/sparks/worktree";
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

test("resolveRevision prefers env, then git, then the revision file", async () => {
  const empty = tmpDir("rev");
  expect(parseRevision("deadbee")).toEqual({ sha: "deadbee", short: "deadbee" });
  expect(resolveRevision(empty, { NCLI_REVISION: "cafebab123" }).short).toBe("cafebab");
  writeFileSync(join(empty, ".ncli-revision"), `${MAIN}\n`);
  expect(resolveRevision(empty, {}).short).toBe("b5f42a6");

  const repo = await initTempRepo("rev-git");
  const head = readGitHead(repo);
  expect(head).toBeTruthy();
  writeFileSync(join(repo, ".ncli-revision"), `${MAIN}\n`);
  expect(resolveRevision(repo, {}).sha).toBe(head);
});

test("resolveRevision reads a bunx cache path when git is missing", () => {
  const root = join(tmpDir("rev-path"), MAIN);
  mkdirSync(root, { recursive: true });
  expect(resolveRevision(root, {}).sha).toBe(MAIN);
});
