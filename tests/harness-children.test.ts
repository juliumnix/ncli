import { expect, test } from "bun:test";
import { killHarnessChildren, spawnHarness } from "../src/acp/children";

test("killHarnessChildren stops the process group within 2s and can run again", async () => {
  const group = spawnHarness(["bash", "-c", "sleep 30 & echo $!; wait"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stubborn = spawnHarness(
    [process.execPath, "-e", "process.on('SIGTERM', () => {}); await Bun.sleep(30000)"],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  const stdout = group.stdout;
  if (!stdout || typeof stdout === "number") throw new Error("child stdout missing");
  const reader = stdout.getReader();
  const next = await Promise.race([
    reader.read(),
    Bun.sleep(2000).then(() => ({ done: true as const, value: undefined })),
  ]);
  reader.releaseLock();
  const line = new TextDecoder().decode(next.value).trim();
  const grandchild = Number(line.split(/\s+/)[0]);
  expect(grandchild).toBeGreaterThan(0);
  const start = Date.now();
  await killHarnessChildren(300);
  expect(Date.now() - start).toBeLessThan(2000);
  expect(alive(group.pid)).toBe(false);
  expect(alive(grandchild)).toBe(false);
  expect(alive(stubborn.pid)).toBe(false);
  await killHarnessChildren();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
