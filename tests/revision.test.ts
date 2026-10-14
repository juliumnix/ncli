import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  documentedBunx,
  documentedLaunch,
  fetchMainTip,
  ncliSpecAt,
  readyBannerSha,
  testedRevision,
  parseGithubCommitSha,
  readBootRevision,
  parseRevision,
  parseShaFromGithubSpec,
  parseShaFromPath,
  readBunGithubCacheSha,
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

test("parseGithubCommitSha reads a raw sha or a commits JSON body", () => {
  expect(parseGithubCommitSha(`${MAIN}\n`)).toBe(MAIN);
  expect(parseGithubCommitSha(JSON.stringify({ sha: MAIN, commit: { message: "x" } }))).toBe(MAIN);
  expect(parseGithubCommitSha("$Format:%H$")).toBeUndefined();
  expect(parseGithubCommitSha("{")).toBeUndefined();
  expect(shortSha(MAIN)).toBe("b5f42a6");
  expect(parseShaFromPath(`/home/u/.bun/install/cache/github.com/juliumnix/ncli@${MAIN}/src`)).toBe(MAIN);
});

test("an export-subst placeholder is not a revision", () => {
  expect(parseRevision("$Format:%H$")).toBeUndefined();
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

test("resolveRevision reads a github spec when bunx has no .git", () => {
  const empty = tmpDir("rev-spec");
  expect(parseShaFromGithubSpec(`github:juliumnix/ncli#${MAIN}`)).toBe(MAIN);
  expect(resolveRevision(empty, { npm_package_resolved: `github:juliumnix/ncli#${MAIN}` }).sha).toBe(MAIN);
});

test("readBunGithubCacheSha picks the newest ncli@sha cache dir", () => {
  const home = tmpDir("bun-cache");
  const dir = join(home, ".bun/install/cache/github.com/juliumnix");
  mkdirSync(join(dir, `ncli@${MAIN}`), { recursive: true });
  expect(readBunGithubCacheSha(home)).toBe(MAIN);
});

test("fetchMainTip reads the injected GitHub body and never needs git", async () => {
  expect(await fetchMainTip({ get: async () => `${MAIN}\n` })).toBe(MAIN);
  expect(await fetchMainTip({ get: async () => JSON.stringify({ sha: MAIN }) })).toBe(MAIN);
  expect(await fetchMainTip({ get: async () => undefined })).toBeUndefined();
  expect(await fetchMainTip({ get: async () => { throw new Error("offline"); } })).toBeUndefined();
});

test("readBootRevision keeps a set NCLI_REVISION without fetching", () => {
  const empty = tmpDir("rev-pin");
  expect(readBootRevision(empty, { NCLI_REVISION: MAIN }).sha).toBe(MAIN);
});

test("the ready banner follows the pin under test, not live main", () => {
  const pin = "dcf4a93d350f37b5e28999e59373d3978d3993f2";
  const live = "04f0353d350f37b5e28999e59373d3978d3993f2";
  expect(pin).toHaveLength(40);
  expect(live).toHaveLength(40);
  expect(shortSha(readyBannerSha(pin, live))).toBe("dcf4a93");
  expect(shortSha(readyBannerSha(pin, undefined))).toBe("dcf4a93");
});

test("testedRevision prefers NCLI_REVISION, then GITHUB_SHA, then HEAD", () => {
  const pin = "dcf4a93d350f37b5e28999e59373d3978d3993f2";
  const gh = "7a76228677e87053a461aba78b5dfe664b99fd15";
  const head = "9ab93f494576e64e813a8b67bfd52ddaf5cf94c6";
  expect(testedRevision({ NCLI_REVISION: pin, GITHUB_SHA: gh }, head)).toBe(pin);
  expect(testedRevision({ GITHUB_SHA: gh }, head)).toBe(gh);
  expect(testedRevision({}, head)).toBe(head);
  expect(testedRevision({})).toBeUndefined();
});
