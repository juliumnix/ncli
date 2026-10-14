export const COMPACT_MAX_PROCS = 8;

export type CompactProcTiming = {
  pid: number;
  spawnMs: number;
  modelMs: number;
};

type LiveProc = {
  pid: number;
  kill: () => void;
  startedAt: number;
};

export type CompactSpawn = (argv: string[], env: Record<string, string>) => CompactChild;

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

  track(pid: number, kill: () => void): void {
    if (this.held > 0) this.held -= 1;
    this.live.set(pid, { pid, kill, startedAt: Date.now() });
  }

  release(pid: number): void {
    if (this.live.has(pid)) this.live.delete(pid);
    else if (this.held > 0) this.held -= 1;
    const next = this.wait.shift();
    if (next) next();
  }

  killAll(): void {
    for (const proc of this.live.values()) {
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

export function bunCompactSpawn(argv: string[], env: Record<string, string>): CompactChild {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
  });
  return {
    pid: proc.pid,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => {
      try {
        proc.kill();
      } catch {
        return;
      }
    },
  };
}

export async function readChildText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}
