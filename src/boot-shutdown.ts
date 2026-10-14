import type { Booted } from "./boot";
import { onShutdown } from "./shutdown";

type Flushable = { paused?: boolean; flushTree?: () => void; saveView?: () => void };

function memories(booted: Booted): Flushable[] {
  const out: Flushable[] = [booted.hub.memory as unknown as Flushable];
  for (const rt of booted.hub.sparks.runtimes.values()) {
    const mem = (rt as unknown as { memory?: Flushable }).memory;
    if (mem) out.push(mem);
  }
  return out;
}

/**
 * Wire the booted hub into the ordered shutdown registry. Appends to
 * main/log.jsonl and tree.jsonl are synchronous whole-line writes, so stage
 * "flush" only has to stop new work and drain treeBuf (muteChange batches).
 */
export function registerBootShutdown(booted: Booted): void {
  onShutdown("flush", () => {
    for (const mem of memories(booted)) {
      mem.paused = true;
      mem.flushTree?.call(mem);
    }
  });
  onShutdown("queue", () => {
    for (const mem of memories(booted)) mem.saveView?.call(mem);
  });
  onShutdown("close", () => booted.stop());
}
