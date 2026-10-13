import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bunxTmpCandidates,
  clearNcliBunxExtracts,
  launchMain,
  listNcliBunxExtracts,
} from "../src/bunx-cache";
import { ncliSpecAt } from "../src/revision";
import { tmpDir } from "./helpers";

const UID = 502;
const MAIN = "ac61d05aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function plantStale(tmp: string, hash = "oldcache", uid = UID): string {
  const dir = join(tmp, `bunx-${uid}-ncli@github@${hash}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "STALE"), "claude-haiku-5-5");
  mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules/.bin/ncli"), "#!/bin/sh\necho STALE_CACHE\n");
  return dir;
}

test("bunxTmpCandidates always includes TMPDIR and /tmp, plus /private/tmp on darwin", () => {
  expect(bunxTmpCandidates({ TMPDIR: "/var/folders/xx/T" }, "linux")).toEqual([
    "/var/folders/xx/T",
    "/tmp",
  ]);
  expect(bunxTmpCandidates({ TMPDIR: "/var/folders/xx/T" }, "darwin")).toEqual([
    "/var/folders/xx/T",
    "/tmp",
    "/private/tmp",
  ]);
  expect(bunxTmpCandidates({}, "linux")).toEqual(["/tmp"]);
});

test("an existing 24h bunx extract is listed and removed before the pinned launch", () => {
  const tmp = tmpDir("bunx-stale");
  const stale = plantStale(tmp);
  expect(listNcliBunxExtracts([tmp], UID)).toEqual([stale]);
  const removed = clearNcliBunxExtracts([tmp], UID);
  expect(removed).toEqual([stale]);
  expect(existsSync(stale)).toBe(false);
  expect(listNcliBunxExtracts([tmp], UID)).toEqual([]);
});

test("launchMain clears the old extract then pins github:juliumnix/ncli to the live sha", () => {
  const tmp = tmpDir("bunx-launch");
  const stale = plantStale(tmp, "deadbeef");
  const plan = launchMain(MAIN, { tmpDirs: [tmp], uid: UID });
  expect(existsSync(stale)).toBe(false);
  expect(plan.removed).toEqual([stale]);
  expect(plan.argv).toEqual(["bunx", ncliSpecAt(MAIN)]);
  expect(plan.env.NCLI_REVISION).toBe(MAIN);
});

test("unrelated bunx extracts stay", () => {
  const tmp = tmpDir("bunx-other");
  const other = join(tmp, `bunx-${UID}-prettier@latest`);
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "keep"), "1");
  plantStale(tmp);
  clearNcliBunxExtracts([tmp], UID);
  expect(existsSync(other)).toBe(true);
});

test("scripts/bunx-main.sh wipes ncli github extracts then pins the live sha", () => {
  const sh = readFileSync(join(import.meta.dir, "../scripts/bunx-main.sh"), "utf8");
  expect(sh).toContain('bunx-"$uid"-ncli@github@*');
  expect(sh).toContain("wipe \"$TMPDIR\"");
  expect(sh).toContain("wipe /tmp");
  expect(sh).toContain("wipe /private/tmp");
  expect(sh).toContain("sha=$NCLI_REVISION");
  expect(sh).toContain("NCLI_BUNX_TMPDIRS");
  expect(sh).toContain("api.github.com/repos/juliumnix/ncli/commits/main");
  expect(sh).toContain("application/vnd.github.sha");
  expect(sh).not.toContain("git ls-remote");
  expect(sh).toContain('bunx "github:juliumnix/ncli#$sha"');
});

test("bunx-main.sh deletes a planted stale extract then execs the pinned spec", () => {
  const tmp = tmpDir("bunx-sh");
  const uid = process.getuid();
  const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const stale = plantStale(tmp, "oldcache", uid);
  const other = join(tmp, `bunx-${uid}-prettier@latest`);
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "keep"), "1");
  const outside = plantStale(join(tmp, "outside"), "globalcache", uid);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 30\nexit 1\n");
  writeFileSync(join(bin, "curl"), "#!/bin/sh\nsleep 30\nexit 1\n");
  writeFileSync(
    join(bin, "bunx"),
    "#!/bin/sh\necho BUNX \"$@\"\necho NCLI_REVISION=$NCLI_REVISION\n",
  );
  writeFileSync(join(bin, "id"), "#!/bin/sh\necho " + String(uid) + "\n");
  for (const name of ["git", "curl", "bunx", "id"]) {
    const proc = Bun.spawnSync(["chmod", "+x", join(bin, name)]);
    expect(proc.exitCode).toBe(0);
  }
  const ran = Bun.spawnSync(["sh", join(import.meta.dir, "../scripts/bunx-main.sh")], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: tmp,
      HOME: tmp,
      NCLI_REVISION: sha,
      NCLI_BUNX_TMPDIRS: tmp,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });
  expect(ran.exitCode, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(join(stale, "STALE"))).toBe(false);
  expect(existsSync(other)).toBe(true);
  expect(existsSync(outside)).toBe(true);
  expect(ran.stdout.toString()).toContain(`BUNX github:juliumnix/ncli#${sha}`);
  expect(ran.stdout.toString()).toContain(`NCLI_REVISION=${sha}`);
  expect(ran.stderr.toString()).toContain(`NCLI: main ${sha}`);
});

test("bunx-main.sh pins the sha from a fake GitHub curl, not git", () => {
  const tmp = tmpDir("bunx-sh-curl");
  const uid = process.getuid();
  const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const stale = plantStale(tmp, "oldcache", uid);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 30\nexit 1\n");
  writeFileSync(join(bin, "curl"), `#!/bin/sh\necho ${sha}\n`);
  writeFileSync(
    join(bin, "bunx"),
    "#!/bin/sh\necho BUNX \"$@\"\necho NCLI_REVISION=$NCLI_REVISION\n",
  );
  writeFileSync(join(bin, "id"), "#!/bin/sh\necho " + String(uid) + "\n");
  for (const name of ["git", "curl", "bunx", "id"]) {
    const proc = Bun.spawnSync(["chmod", "+x", join(bin, name)]);
    expect(proc.exitCode).toBe(0);
  }
  const ran = Bun.spawnSync(["sh", join(import.meta.dir, "../scripts/bunx-main.sh")], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: tmp,
      HOME: tmp,
      NCLI_BUNX_TMPDIRS: tmp,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });
  expect(ran.exitCode, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  expect(existsSync(stale)).toBe(false);
  expect(ran.stdout.toString()).toContain(`BUNX github:juliumnix/ncli#${sha}`);
  expect(ran.stdout.toString()).toContain(`NCLI_REVISION=${sha}`);
});
