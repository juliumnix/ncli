import { expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { bindCompactShutdown, createCompactEngine } from "../src/memory/compact-engine";
import { bunCompactSpawn, CompactProcPool, killProcessGroup, pathOnlyEnv } from "../src/memory/compact-proc";
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

function leftoverCodexExec(bin: string): number[] {
  const out: number[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0");
      const at = cmd.indexOf(bin);
      if (at >= 0 && cmd[at + 1] === "exec") out.push(Number(d));
    } catch {
      continue;
    }
  }
  return out;
}

async function fakeCodexBatch(dir: string, n: number): Promise<{ bin: string; pids: number[]; kids: Array<ReturnType<typeof bunCompactSpawn>> }> {
  const bin = join(dir, "codex");
  writeFileSync(bin, "#!/usr/bin/env bun\nawait Bun.sleep(60_000);\n");
  chmodSync(bin, 0o755);
  const kids = [];
  const pids: number[] = [];
  for (let i = 0; i < n; i++) {
    const child = bunCompactSpawn([bin, "exec", "--json", `batch-${i}`], pathOnlyEnv(), { timeoutMs: 60_000 });
    kids.push(child);
    pids.push(child.pid);
  }
  const started = Date.now();
  while (Date.now() - started < 4000 && leftoverCodexExec(bin).length < n) await Bun.sleep(40);
  expect(leftoverCodexExec(bin).length).toBe(n);
  return { bin, pids, kids };
}

test("bindCompactShutdown runs killAll when the hook slot exists", () => {
  let killed = 0;
  bindCompactShutdown({ killAll: () => { killed += 1; } }, (fn) => fn());
  expect(killed).toBe(1);
  bindCompactShutdown({ killAll: () => { killed += 1; } });
  expect(killed).toBe(1);
});

test("killAll mid-batch leaves 0 codex exec", async () => {
  const dir = tmpDir("killall-exec");
  const { bin, kids } = await fakeCodexBatch(dir, 3);
  const pool = new CompactProcPool();
  for (const child of kids) pool.track(child.pid, () => child.kill());
  pool.killAll();
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && leftoverCodexExec(bin).length) await Bun.sleep(40);
  expect(leftoverCodexExec(bin)).toEqual([]);
});

test("killing the parent mid-batch leaves 0 codex exec", async () => {
  const dir = tmpDir("parent-batch");
  const bin = join(dir, "codex");
  const ready = join(dir, "ready.txt");
  writeFileSync(bin, "#!/usr/bin/env bun\nawait Bun.sleep(60_000);\n");
  chmodSync(bin, 0o755);
  const parentFile = join(dir, "parent.ts");
  writeFileSync(
    parentFile,
    `import { bunCompactSpawn, pathOnlyEnv } from ${JSON.stringify(join(import.meta.dir, "../src/memory/compact-proc.ts"))};
const bin = ${JSON.stringify(bin)};
const kids = [0, 1, 2].map((i) => bunCompactSpawn([bin, "exec", "--json", "batch-" + i], pathOnlyEnv(), { timeoutMs: 60_000 }));
await Bun.write(${JSON.stringify(ready)}, kids.map((k) => k.pid).join("\\n"));
await Promise.all(kids.map((k) => k.exited));
`,
  );
  const parent = Bun.spawn([process.execPath, parentFile], {
    stdout: "ignore",
    stderr: "ignore",
    env: pathOnlyEnv(),
  });
  const started = Date.now();
  while (Date.now() - started < 4000) {
    try {
      if ((await Bun.file(ready).text()).trim().split("\n").length === 3) break;
    } catch {
    }
    await Bun.sleep(40);
  }
  expect(leftoverCodexExec(bin).length).toBe(3);
  process.kill(parent.pid, "SIGKILL");
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && leftoverCodexExec(bin).length) await Bun.sleep(50);
  expect(leftoverCodexExec(bin)).toEqual([]);
  expect(alive(parent.pid)).toBe(false);
});

test("engine.killAll kills a fake codex and its sleep grandchild", async () => {
  const dir = tmpDir("killall-grandchild");
  const bin = join(dir, "codex");
  const gpFile = join(dir, "grandchild.pid");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "mcp" ]; then
  echo '[]'
  exit 0
fi
sleep 30 &
echo $! > ${JSON.stringify(gpFile)}
wait
`,
  );
  chmodSync(bin, 0o755);
  const engine = createCompactEngine(
    loadConfig({
      dataDir: dir,
      compactBackend: "cursor",
      compactSkipTokens: 1,
      compactTimeoutMs: 60_000,
      compactDebounceMs: 1,
      harness: "cursor",
      codexBin: bin,
    }),
    {
      spawn: (argv, env, opts) => {
        const child = bunCompactSpawn(argv, env, opts);
        return {
          ...child,
          kill: () => {
            try {
              process.kill(child.pid, "SIGKILL");
            } catch {
              return;
            }
          },
        };
      },
    },
  );
  engine.setChoice({ mode: "cli", provider: "codex", model: "mini" });
  const job = engine.compress({
    kind: "leaf",
    source: "user: FACT_ORPHAN",
    contextLines: [],
    nodeBytes: 80,
  }).catch(() => undefined);
  const started = Date.now();
  let grandchild = 0;
  while (Date.now() - started < 4000) {
    try {
      grandchild = Number((await Bun.file(gpFile).text()).trim());
      if (grandchild > 1) break;
    } catch {
    }
    await Bun.sleep(40);
  }
  expect(grandchild).toBeGreaterThan(1);
  expect(alive(grandchild)).toBe(true);
  const parents = leftoverCodexExec(bin);
  expect(parents.length).toBe(1);
  await engine.killAll();
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && (alive(grandchild) || leftoverCodexExec(bin).length)) {
    await Bun.sleep(40);
  }
  expect(alive(grandchild)).toBe(false);
  expect(leftoverCodexExec(bin)).toEqual([]);
  expect([grandchild, ...parents].filter(alive)).toEqual([]);
  await job;
});
