import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunCompactSpawn, killProcessGroup, pathOnlyEnv } from "../src/memory/compact-proc";
import { tmpDir } from "./helpers";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a compact child is a process group leader and times out as a group", async () => {
  const child = bunCompactSpawn(["sleep", "20"], pathOnlyEnv(), { timeoutMs: 400 });
  expect(child.pid).toBeGreaterThan(1);
  const pgid = Number((await Bun.$`ps -o pgid= -p ${child.pid}`.text()).trim());
  expect(pgid).toBe(child.pid);
  const t0 = Date.now();
  const code = await child.exited;
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(code).not.toBe(0);
  expect(alive(child.pid)).toBe(false);
});

test("killProcessGroup removes the child and its descendants", async () => {
  const child = bunCompactSpawn(["sleep", "20"], pathOnlyEnv(), { timeoutMs: 8000 });
  expect(alive(child.pid)).toBe(true);
  killProcessGroup(child.pid);
  await child.exited;
  expect(alive(child.pid)).toBe(false);
});

test("SIGKILL on the compact parent kills the detached child group", async () => {
  const dir = tmpDir("pg-death");
  const pidFile = join(dir, "child.pid");
  const parentFile = join(dir, "parent.ts");
  writeFileSync(
    parentFile,
    `import { bunCompactSpawn, pathOnlyEnv } from ${JSON.stringify(join(import.meta.dir, "../src/memory/compact-proc.ts"))};
const child = bunCompactSpawn(["sleep", "30"], pathOnlyEnv(), { timeoutMs: 60_000 });
await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
await child.exited;
`,
  );
  const parent = Bun.spawn([process.execPath, parentFile], {
    stdout: "ignore",
    stderr: "ignore",
    env: pathOnlyEnv(),
  });
  const started = Date.now();
  let childPid = 0;
  while (Date.now() - started < 4000) {
    try {
      childPid = Number((await Bun.file(pidFile).text()).trim());
      if (childPid > 1) break;
    } catch {
    }
    await Bun.sleep(50);
  }
  expect(childPid).toBeGreaterThan(1);
  expect(alive(childPid)).toBe(true);
  process.kill(parent.pid, "SIGKILL");
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && alive(childPid)) await Bun.sleep(50);
  expect(alive(childPid)).toBe(false);
  expect(alive(parent.pid)).toBe(false);
});
