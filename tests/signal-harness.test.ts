import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initTempRepo } from "../src/sparks/worktree";

const ENTRY = join(import.meta.dir, "../src/index.ts");

const GROUP_EXEC = [
  'import { dlopen, FFIType, ptr } from "bun:ffi";',
  'const lib = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";',
  "const libc = dlopen(lib, {",
  "  setpgid: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },",
  "  execvp: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },",
  "});",
  "if (libc.symbols.setpgid(0, 0) !== 0) process.exit(126);",
  "const args = process.argv.slice(1);",
  'const bufs = args.map((arg) => Buffer.from(arg + "\\0"));',
  "const arr = new BigUint64Array(args.length + 1);",
  "for (let i = 0; i < bufs.length; i++) arr[i] = BigInt(ptr(bufs[i]));",
  "const file = bufs[0];",
  "if (!file || libc.symbols.execvp(ptr(file), ptr(arr)) !== 0) process.exit(127);",
].join("\n");

const HOLD_TS = `import { appendFileSync } from "node:fs";
const log = process.env.HOLD_LOG ?? "";
const child = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
if (log) appendFileSync(log, JSON.stringify({ pid: process.pid, child: child.pid }) + "\\n");
await Bun.sleep(120_000);
`;

test("SIGINT to the server group mid-turn kills the harness group once", async () => {
  await midTurn("SIGINT", 130, true);
}, 20_000);

test("SIGTERM to the server pid mid-turn kills the harness group", async () => {
  await midTurn("SIGTERM", 143, false);
}, 20_000);

async function midTurn(signal: "SIGINT" | "SIGTERM", code: number, group: boolean): Promise<void> {
  const scratch = join(tmpdir(), `ncli-sig-${process.pid}-${signal}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const project = await initTempRepo(`ncli-sig-${signal}`);
  const dataDir = join(project, "data");
  const home = join(scratch, "home");
  const holdLog = join(scratch, "hold.jsonl");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(scratch, "codex"), { recursive: true });
  mkdirSync(join(scratch, "claude"), { recursive: true });
  const bin = join(scratch, "hold");
  writeFileSync(
    bin,
    "#!/usr/bin/env bash\nset -euo pipefail\ndir=$(cd \"$(dirname \"$0\")\" && pwd)\nexec bun \"$dir/hold.ts\" \"$@\"\n",
  );
  chmodSync(bin, 0o755);
  writeFileSync(join(scratch, "hold.ts"), HOLD_TS);
  const env: Record<string, string> = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    CODEX_HOME: join(scratch, "codex"),
    CLAUDE_CONFIG_DIR: join(scratch, "claude"),
    LANG: "C",
    NCLI_HARNESS: "codex",
    NCLI_COMPACT: "mock",
    NCLI_GH: "mock",
    NCLI_NO_OPEN: "1",
    NCLI_DATA: dataDir,
    NCLI_REPO: project,
    NCLI_CODEX: bin,
    HOLD_LOG: holdLog,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  let server: Bun.Subprocess | undefined;
  const tracked: number[] = [];
  let logs = "";
  try {
    server = spawnGrouped(env, project, (chunk) => {
      logs += chunk;
    });
    const port = await waitPort(server, () => logs);
    const posted = await fetch(`http://127.0.0.1:${port}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hold-turn" }),
      signal: AbortSignal.timeout(4000),
    });
    if (!posted.ok) throw new Error("turn did not start");
    await posted.body?.cancel();
    const row = await waitHold(holdLog, dataDir, server);
    tracked.push(row.pid, row.child);
    if (groupOf(server.pid) !== server.pid) throw new Error("server group");
    if (groupOf(row.pid) !== row.pid || groupOf(row.child) !== row.pid) throw new Error("harness group");
    poke(server.pid, signal, group);
    poke(server.pid, signal, group);
    const exited = await Promise.race([server.exited, Bun.sleep(8000).then(() => -1)]);
    if (exited !== code) throw new Error("server did not exit");
    await untilDead([row.pid, row.child]);
    assertJsonl(dataDir);
    expect(alive(row.pid)).toBe(false);
    expect(alive(row.child)).toBe(false);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "signal test failed";
    throw new Error(scrub(reason));
  } finally {
    if (server && server.exitCode === null) reap(server.pid);
    for (const pid of tracked) reap(pid);
    rmSync(scratch, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

function spawnGrouped(
  env: Record<string, string>,
  cwd: string,
  onLog: (chunk: string) => void,
): Bun.Subprocess {
  const proc = Bun.spawn([process.execPath, "-e", GROUP_EXEC, process.execPath, ENTRY], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  if (stdout && typeof stdout !== "number") void drain(stdout, onLog);
  if (stderr && typeof stderr !== "number") void drain(stderr, onLog);
  return proc;
}

async function drain(stream: ReadableStream<Uint8Array>, onLog: (chunk: string) => void): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      onLog(dec.decode(next.value));
    }
  } finally {
    reader.releaseLock();
  }
}

async function waitPort(proc: Bun.Subprocess, readLog: () => string): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < 12000) {
    const match = readLog().match(/localhost:(\d+)/);
    if (match?.[1]) return Number(match[1]);
    if (proc.exitCode !== null) break;
    await Bun.sleep(40);
  }
  const snippet = scrub(readLog()).slice(0, 180);
  throw new Error(snippet || "no banner");
}

async function waitHold(
  logPath: string,
  dataDir: string,
  proc: Bun.Subprocess,
): Promise<{ pid: number; child: number }> {
  const userLog = join(dataDir, "main/log.jsonl");
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (proc.exitCode !== null) break;
    const marked = existsSync(userLog) && readFileSync(userLog, "utf8").includes("hold-turn");
    if (marked && existsSync(logPath)) {
      const line = readFileSync(logPath, "utf8").trim().split("\n").at(-1) ?? "";
      const row = parseHold(line);
      if (row && alive(row.pid) && alive(row.child)) return row;
    }
    await Bun.sleep(30);
  }
  throw new Error("turn did not start");
}

function parseHold(line: string): { pid: number; child: number } | undefined {
  try {
    const row = JSON.parse(line) as { pid?: number; child?: number };
    if (!row.pid || !row.child) return undefined;
    return { pid: row.pid, child: row.child };
  } catch {
    return undefined;
  }
}

function assertJsonl(dataDir: string): void {
  const main = join(dataDir, "main");
  let sawUser = false;
  let sawLine = false;
  for (const name of readdirSync(main)) {
    if (!name.endsWith(".jsonl")) continue;
    const text = readFileSync(join(main, name), "utf8");
    if (!text) continue;
    sawLine = true;
    if (!text.endsWith("\n")) throw new Error("jsonl truncated");
    for (const line of text.split("\n")) {
      if (!line) continue;
      let row: { text?: string };
      try {
        row = JSON.parse(line) as { text?: string };
      } catch {
        throw new Error("jsonl line");
      }
      if (row.text === "hold-turn") sawUser = true;
    }
  }
  if (!sawLine || !sawUser) throw new Error("jsonl truncated");
}

async function untilDead(pids: number[]): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (pids.every((pid) => !alive(pid))) return;
    await Bun.sleep(20);
  }
  throw new Error("harness still running");
}

function groupOf(pid: number): number {
  const ran = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  return Number(new TextDecoder().decode(ran.stdout).trim());
}

function poke(pid: number, signal: NodeJS.Signals, group: boolean): void {
  try {
    process.kill(group ? -pid : pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("signal failed");
  }
}

function reap(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function scrub(text: string): string {
  return text.replace(/(^|[\s"'=])\/[^\s"']+/g, "$1<path>");
}
