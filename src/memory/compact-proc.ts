import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

export const COMPACT_MAX_PROCS = 8;
export const COMPACT_CHILD_TIMEOUT_MS = 120_000;

export type CompactProcTiming = {
  pid: number;
  spawnMs: number;
  modelMs: number;
};

type LiveProc = {
  pid: number;
  kill: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

export function isolatedCompactCwd(dataDir: string): string {
  const dir = join(dataDir, "compact-empty");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type CompactSpawnOpts = { cwd?: string; timeoutMs?: number };

export type CompactSpawn = (argv: string[], env: Record<string, string>, opts?: CompactSpawnOpts) => CompactChild;

export type CompactChild = {
  pid: number;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: () => void;
};

export class CompactProcPool {
  private readonly live = new Map<number, LiveProc>();
  private readonly wait: Array<() => void> = [];
  private nextFake = -1;
  private held = 0;

  get size(): number {
    return this.live.size + this.held;
  }

  pids(): number[] {
    return [...this.live.keys()];
  }

  async acquire(): Promise<void> {
    while (this.live.size + this.held >= COMPACT_MAX_PROCS) {
      await new Promise<void>((resolve) => this.wait.push(resolve));
    }
    this.held += 1;
  }

  track(pid: number, kill: () => void, timeoutMs = 0): void {
    if (this.held > 0) this.held -= 1;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        try {
          kill();
        } catch {
          return;
        }
      }, timeoutMs)
      : undefined;
    this.live.set(pid, { pid, kill, timer });
  }

  releaseHeld(): void {
    if (this.held > 0) this.held -= 1;
    const next = this.wait.shift();
    if (next) next();
  }

  release(pid: number): void {
    const row = this.live.get(pid);
    if (row?.timer) clearTimeout(row.timer);
    if (this.live.has(pid)) {
      this.live.delete(pid);
      const next = this.wait.shift();
      if (next) next();
      return;
    }
    this.releaseHeld();
  }

  killAll(): void {
    for (const proc of this.live.values()) {
      if (proc.timer) clearTimeout(proc.timer);
      try {
        proc.kill();
      } catch {
        continue;
      }
    }
    this.live.clear();
    this.held = 0;
    while (this.wait.length) this.wait.shift()?.();
  }

  allocPid(): number {
    const pid = this.nextFake;
    this.nextFake -= 1;
    return pid;
  }
}

export function pathOnlyEnv(path = process.env.PATH): Record<string, string> {
  return { PATH: path ?? "/usr/bin:/bin" };
}

export function killProcessGroup(pid: number): void {
  if (pid <= 1 || pid === process.pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  }
}

export function bunCompactSpawn(argv: string[], env: Record<string, string>, opts: CompactSpawnOpts = {}): CompactChild {
  if (!argv[0]) throw new Error("compact spawn needs a command");
  const timeoutMs = opts.timeoutMs ?? COMPACT_CHILD_TIMEOUT_MS;
  const child = nodeSpawn(argv[0], argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    cwd: opts.cwd || undefined,
    detached: true,
  });
  const pid = child.pid;
  if (!pid) throw new Error("compact spawn produced no pid");
  const watchdog = spawnParentWatchdog(process.pid, pid);
  let timedOut = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      killProcessGroup(pid);
    }, timeoutMs)
    : undefined;
  const kill = () => {
    if (timer) clearTimeout(timer);
    killProcessGroup(pid);
    stopWatchdog(watchdog);
  };
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      stopWatchdog(watchdog);
      if (timedOut) {
        resolve(124);
        return;
      }
      resolve(code ?? (signal ? 1 : 0));
    });
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      stopWatchdog(watchdog);
      resolve(1);
    });
  });
  return {
    pid,
    stdout: nodeStream(child.stdout),
    stderr: nodeStream(child.stderr),
    exited,
    kill,
  };
}

export async function readChildText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

function spawnParentWatchdog(parentPid: number, childPid: number): number {
  const script = [
    `while kill -0 ${parentPid} 2>/dev/null; do`,
    `  if ! kill -0 ${childPid} 2>/dev/null; then exit 0; fi`,
    "  sleep 0.1",
    "done",
    `kill -9 -${childPid} 2>/dev/null`,
    "exit 0",
  ].join("\n");
  const dog = nodeSpawn("sh", ["-c", script], {
    stdio: "ignore",
    detached: true,
  });
  dog.unref();
  return dog.pid ?? 0;
}

function stopWatchdog(pid: number): void {
  if (pid <= 1) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
}

function nodeStream(stream: NodeJS.ReadableStream | null): ReadableStream<Uint8Array> | null {
  if (!stream) return null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel() {
      stream.removeAllListeners();
    },
  });
}
