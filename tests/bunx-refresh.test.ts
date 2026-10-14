import { expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bunxExtractRoot,
  clearNcliBunxExtracts,
  ncliExtractName,
  planBunxRefresh,
} from "../src/bunx-cache";
import { ncliSpecAt } from "../src/revision";
import { tmpDir } from "./helpers";

const UID = 502;
const LIVE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function plantExtract(tmp: string, hash = "18408305413554282373"): string {
  const dir = join(tmp, `bunx-${UID}-ncli@github@${hash}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/index.ts"), "export {}\n");
  return dir;
}

test("bunxExtractRoot recognizes Julio's /private/tmp extract layout", () => {
  const path = `/private/tmp/bunx-${UID}-ncli@github@18408305413554282373/src/index.ts`;
  expect(bunxExtractRoot(path, UID)).toBe(`/private/tmp/bunx-${UID}-ncli@github@18408305413554282373`);
  expect(bunxExtractRoot("/workspace/src/index.ts", UID)).toBeUndefined();
  expect(ncliExtractName(path, UID)).toBe(`bunx-${UID}-ncli@github@18408305413554282373`);
  expect(ncliExtractName(`/tmp/bunx-${UID}-ncli@github@18408305413554282373`, UID)).toBe(
    `bunx-${UID}-ncli@github@18408305413554282373`,
  );
});

test("a bunx extract without NCLI_REVISION re-execs the pinned spec even if .ncli-revision matches", () => {
  const tmp = tmpDir("bunx-refresh");
  const extract = plantExtract(tmp);
  writeFileSync(join(extract, ".ncli-revision"), `${LIVE}\n`);
  const plan = planBunxRefresh({
    runningPath: join(extract, "src/index.ts"),
    env: {},
    uid: UID,
    remoteSha: LIVE,
    tmpDirs: [tmp],
  });
  expect(plan).toEqual({
    kind: "reexec",
    argv: ["bunx", ncliSpecAt(LIVE)],
    env: { NCLI_REVISION: LIVE },
    removed: [],
  });
});

test("a pinned extract re-execs bunx when live main moved", () => {
  const tmp = tmpDir("bunx-fresh");
  const extract = plantExtract(tmp);
  const next = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const plan = planBunxRefresh({
    runningPath: join(extract, "src/index.ts"),
    env: { NCLI_REVISION: LIVE },
    uid: UID,
    remoteSha: next,
    tmpDirs: [tmp],
  });
  expect(plan).toEqual({
    kind: "reexec",
    argv: ["bunx", ncliSpecAt(next)],
    env: { NCLI_REVISION: next },
    removed: [],
  });
});

test("a pinned extract that already matches remote boots in place", () => {
  const tmp = tmpDir("bunx-current");
  const extract = plantExtract(tmp);
  const plan = planBunxRefresh({
    runningPath: join(extract, "src/index.ts"),
    env: { NCLI_REVISION: LIVE },
    uid: UID,
    remoteSha: LIVE,
    tmpDirs: [tmp],
  });
  expect(plan).toEqual({ kind: "boot" });
});

test("a git clone does not re-exec bunx", () => {
  const root = tmpDir("clone");
  const plan = planBunxRefresh({
    runningPath: join(root, "src/index.ts"),
    env: {},
    uid: UID,
    remoteSha: LIVE,
    tmpDirs: [root],
  });
  expect(plan).toEqual({ kind: "boot" });
});

test("without a live main tip, boot the extract in place", () => {
  const tmp = tmpDir("bunx-offline");
  const extract = plantExtract(tmp);
  const plan = planBunxRefresh({
    runningPath: join(extract, "src/index.ts"),
    env: {},
    uid: UID,
    tmpDirs: [tmp],
  });
  expect(plan).toEqual({ kind: "boot" });
});

test("re-exec wipes sibling extracts and keeps a /tmp alias of the running dir", () => {
  const tmp = tmpDir("bunx-alias");
  const privateTmp = join(tmp, "private-tmp");
  const tmpAlias = join(tmp, "tmp");
  mkdirSync(privateTmp, { recursive: true });
  symlinkSync(privateTmp, tmpAlias);
  const extract = plantExtract(privateTmp);
  const sibling = plantExtract(privateTmp, "999");
  const aliased = join(tmpAlias, `bunx-${UID}-ncli@github@18408305413554282373`);
  const plan = planBunxRefresh({
    runningPath: join(extract, "src/index.ts"),
    env: {},
    uid: UID,
    remoteSha: LIVE,
    tmpDirs: [tmpAlias, privateTmp],
  });
  expect(plan.kind).toBe("reexec");
  expect(existsSync(extract)).toBe(true);
  expect(existsSync(aliased)).toBe(true);
  expect(existsSync(sibling)).toBe(false);
  if (plan.kind === "reexec") expect(plan.removed).toEqual([join(tmpAlias, `bunx-${UID}-ncli@github@999`)]);
});

test("clearNcliBunxExtracts does not rm the running extract through a symlink", () => {
  const tmp = tmpDir("bunx-skip-link");
  const real = join(tmp, "private-tmp");
  const alias = join(tmp, "tmp");
  mkdirSync(real, { recursive: true });
  symlinkSync(real, alias);
  const extract = plantExtract(real);
  const removed = clearNcliBunxExtracts([alias, real], UID, extract);
  expect(removed).toEqual([]);
  expect(existsSync(extract)).toBe(true);
});
