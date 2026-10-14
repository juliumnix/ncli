import type { Booted } from "./boot";
import type { Memory } from "./memory/store";
import { killHarnessChildren } from "./acp/children";
import { onShutdown, setHarnessKiller } from "./shutdown";

/** What the shutdown stages need from a Memory. Resolved and checked once, at boot. */
type MemoryHooks = { mem: Memory; flushTree: () => void; saveView: () => void };

/**
 * Resolve the private flush/save methods of a Memory and fail loud if they are
 * missing (e.g. renamed in store.ts): a silent no-op would truncate tree.jsonl on
 * shutdown without any error.
 */
export function memoryHooks(mem: Memory): MemoryHooks {
  const flushTree: unknown = mem["flushTree"];
  const saveView: unknown = mem["saveView"];
  if (typeof flushTree !== "function") {
    throw new Error("ncli shutdown: Memory.flushTree is not a function (renamed in src/memory/store.ts?)");
  }
  if (typeof saveView !== "function") {
    throw new Error("ncli shutdown: Memory.saveView is not a function (renamed in src/memory/store.ts?)");
  }
  return {
    mem,
    flushTree: () => (flushTree as () => void).call(mem),
    saveView: () => (saveView as () => void).call(mem),
  };
}

/** Optional hook slot: refine-queue persister (`persistRefineQueue` from PR #65), run in stage "queue". */
let queuePersister: (() => void | Promise<void>) | undefined;
export function setQueuePersister(fn: (() => void | Promise<void>) | undefined): void {
  queuePersister = fn;
}

function memories(booted: Booted): MemoryHooks[] {
  const out = [memoryHooks(booted.hub.memory)];
  for (const rt of booted.hub.sparks.runtimes.values()) {
    const mem = (rt as unknown as { memory?: Memory }).memory;
    if (mem) out.push(memoryHooks(mem));
  }
  return out;
}

/**
 * Wire the booted hub into the ordered shutdown registry. Appends to
 * main/log.jsonl and tree.jsonl are synchronous whole-line writes, so stage
 * "flush" only has to stop new work and drain treeBuf (muteChange batches).
 * Throws immediately if a Memory lacks flushTree/saveView.
 */
export function registerBootShutdown(booted: Booted): void {
  memories(booted);
  setHarnessKiller(() => killHarnessChildren(2000));
  onShutdown("flush", () => {
    for (const h of memories(booted)) {
      h.mem.paused = true;
      h.flushTree();
    }
  });
  onShutdown("queue", async () => {
    for (const h of memories(booted)) h.saveView();
    if (queuePersister) await queuePersister();
  });
  onShutdown("close", () => booted.close());
}
