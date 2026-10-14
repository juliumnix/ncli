const live = new Set<number>();

const GROUP_EXEC = [
  'import { dlopen, FFIType, ptr } from "bun:ffi";',
  'const lib = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";',
  "const libc = dlopen(lib, {",
  "  setpgid: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },",
  "  execvp: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },",
  "});",
  "libc.symbols.setpgid(0, 0);",
  "const args = process.argv.slice(1);",
  'const bufs = args.map((arg) => Buffer.from(arg + "\\0"));',
  "const arr = new BigUint64Array(args.length + 1);",
  "for (let i = 0; i < bufs.length; i++) arr[i] = BigInt(ptr(bufs[i]));",
  "const file = bufs[0];",
  "if (!file || libc.symbols.execvp(ptr(file), ptr(arr)) !== 0) process.exit(127);",
].join("\n");

type HarnessStdio = "pipe" | "ignore" | "inherit";

export function spawnHarness(
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: HarnessStdio;
    stdout?: HarnessStdio;
    stderr?: HarnessStdio;
  } = {},
): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn([process.execPath, "-e", GROUP_EXEC, ...args], opts);
  if (proc.pid > 0) live.add(proc.pid);
  void proc.exited.finally(() => {
    live.delete(proc.pid);
  });
  return proc;
}

export async function killHarnessChildren(timeoutMs = 2000): Promise<void> {
  const pids = [...live];
  if (pids.length === 0) return;
  for (const pid of pids) signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(20);
  for (const pid of pids) {
    if (alive(pid)) signalGroup(pid, "SIGKILL");
  }
  const killed = Date.now() + 200;
  while (pids.some(alive) && Date.now() < killed) await Bun.sleep(20);
  for (const pid of pids) live.delete(pid);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw err;
  }
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
