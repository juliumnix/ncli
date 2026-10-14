import { createReadStream } from "node:fs";

/**
 * Ordered, async shutdown registry for the ncli process that owns the port.
 *
 * Stages always run in this order, each awaited before the next:
 *   1. flush      — finish in-flight appends to main/*.jsonl and tree.jsonl (incl. treeBuf)
 *   2. harness    — kill harness children (wired later to `killHarnessChildren(2000)` from src/acp/)
 *   3. compactor  — kill compactor pool children (wired later to `engine.killAll()`)
 *   4. queue      — save the compaction queue / view
 *   5. close      — stop the HTTP server, live origin, bus
 *
 * A stage callback that throws or exceeds its timeout is logged and skipped so
 * later stages still run. `runShutdown` is idempotent.
 */
export const SHUTDOWN_STAGES = ["flush", "harness", "compactor", "queue", "close"] as const;
export type ShutdownStage = (typeof SHUTDOWN_STAGES)[number];
export type ShutdownFn = (reason: string) => void | Promise<void>;

const registry = new Map<ShutdownStage, ShutdownFn[]>();
let running: Promise<void> | undefined;
const STAGE_TIMEOUT_MS = 2_500;

export function onShutdown(stage: ShutdownStage, fn: ShutdownFn): () => void {
  const list = registry.get(stage) ?? [];
  list.push(fn);
  registry.set(stage, list);
  return () => {
    const cur = registry.get(stage);
    if (!cur) return;
    const at = cur.indexOf(fn);
    if (at >= 0) cur.splice(at, 1);
  };
}

/** Optional hook slot: harness children killer (`killHarnessChildren(timeoutMs)` from src/acp/, other PR). */
let harnessKiller: ((timeoutMs: number) => void | Promise<void>) | undefined;
export function setHarnessKiller(fn: ((timeoutMs: number) => void | Promise<void>) | undefined): void {
  harnessKiller = fn;
}

/** Optional hook slot: compactor pool killer (`engine.killAll()` from the compact engine, other PR). */
let compactorKiller: (() => void | Promise<void>) | undefined;
export function setCompactorKiller(fn: (() => void | Promise<void>) | undefined): void {
  compactorKiller = fn;
}

export function shutdownStarted(): boolean {
  return running !== undefined;
}

export function runShutdown(reason: string): Promise<void> {
  running ??= (async () => {
    for (const stage of SHUTDOWN_STAGES) {
      const fns = [...(registry.get(stage) ?? [])];
      if (stage === "harness" && harnessKiller) {
        const k = harnessKiller;
        fns.push(() => k(2_000));
      }
      if (stage === "compactor" && compactorKiller) fns.push(compactorKiller);
      for (const fn of fns) {
        try {
          await withTimeout(Promise.resolve().then(() => fn(reason)), STAGE_TIMEOUT_MS);
        } catch (err) {
          process.stderr.write(`ncli shutdown ${stage}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
  })();
  return running;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<undefined>((_, rej) => {
      t = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
type FwdSignal = keyof typeof SIGNAL_CODES;
const FORWARD: FwdSignal[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/** fd the parent keeps open for the child; it reads EOF when the parent dies. */
export const PARENT_PIPE_FD = 3;
export const PARENT_PIPE_ENV = "NCLI_PARENT_PIPE";
export const PARENT_PID_ENV = "NCLI_PARENT_PID";

/**
 * Parent side of the bunx re-exec: spawn the child, forward SIGTERM/SIGINT/SIGHUP,
 * hold a pipe on fd 3 so the child sees EOF if we die (even by SIGKILL), and
 * resolve with the child's exit code.
 */
export async function superviseChild(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const child = Bun.spawn(argv, {
    stdio: ["inherit", "inherit", "inherit", "pipe"],
    env: { ...env, [PARENT_PIPE_ENV]: String(PARENT_PIPE_FD), [PARENT_PID_ENV]: String(process.pid) },
  });
  const handlers = FORWARD.map((sig) => {
    const h = () => {
      try {
        child.kill(sig);
      } catch {}
    };
    process.on(sig, h);
    return [sig, h] as const;
  });
  const code = await child.exited;
  for (const [sig, h] of handlers) process.off(sig, h);
  if (code !== null && code !== undefined) return code;
  const sig = child.signalCode as FwdSignal | null;
  return sig && sig in SIGNAL_CODES ? SIGNAL_CODES[sig] : 1;
}

/**
 * Child side: run the ordered shutdown on SIGTERM/SIGINT/SIGHUP or when the
 * parent dies (EOF on the parent pipe, or PPID change as a fallback), then exit.
 */
export function installChildShutdown(opts: { pollMs?: number; exit?: (code: number) => void } = {}): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const finish = (reason: string, code: number) => {
    if (shutdownStarted()) return;
    void runShutdown(reason).finally(() => exit(code));
  };
  const handlers = FORWARD.map((sig) => {
    const h = () => finish(sig, SIGNAL_CODES[sig]);
    process.on(sig, h);
    return [sig, h] as const;
  });
  const stops: Array<() => void> = [];
  const parentPid = Number(process.env[PARENT_PID_ENV]);
  if (Number.isInteger(parentPid) && parentPid > 1) {
    const fd = Number(process.env[PARENT_PIPE_ENV]);
    if (Number.isInteger(fd) && fd > 2) {
      try {
        const stream = createReadStream("", { fd, autoClose: true });
        stream.on("data", () => {});
        stream.on("end", () => finish("parent-eof", 143));
        stream.on("error", () => {});
        stops.push(() => stream.destroy());
      } catch {}
    }
    const timer = setInterval(() => {
      if (!parentAlive(parentPid)) finish("parent-gone", 143);
    }, opts.pollMs ?? 250);
    timer.unref?.();
    stops.push(() => clearInterval(timer));
  }
  return () => {
    for (const [sig, h] of handlers) process.off(sig, h);
    for (const s of stops) s();
  };
}

function parentAlive(pid: number): boolean {
  if (process.ppid !== pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Test-only: reset module state. */
export function resetShutdownForTest(): void {
  registry.clear();
  running = undefined;
  harnessKiller = undefined;
  compactorKiller = undefined;
}
