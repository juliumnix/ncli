import type { Booted } from "./boot";
import type { Memory } from "./memory/store";
import { killHarnessChildren } from "./acp/children";
import { bindCompactShutdown, bindQueueShutdown } from "./memory/compact-engine";
import { onShutdown, setCompactorKiller, setHarnessKiller } from "./shutdown";

let queuePersister: (() => void | Promise<void>) | undefined;
export function setQueuePersister(fn: (() => void | Promise<void>) | undefined): void {
  queuePersister = fn;
}

function liveMemories(booted: Booted): Memory[] {
  return [booted.hub.memory, ...booted.hub.sparks.sparkMemories()];
}

function runEachMemory(mems: Memory[], fn: (mem: Memory) => void): void {
  for (const mem of mems) {
    try {
      fn(mem);
    } catch (err) {
      process.stderr.write(`ncli shutdown memory: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

export function registerBootShutdown(booted: Booted): void {
  setHarnessKiller(() => killHarnessChildren(2000));
  bindCompactShutdown(booted.hub.engine, setCompactorKiller);
  bindQueueShutdown(booted.hub.memory, booted.hub.sparks, setQueuePersister);
  onShutdown("flush", () => {
    runEachMemory(liveMemories(booted), (mem) => {
      mem.paused = true;
      mem.shutdown();
    });
  });
  onShutdown("queue", async () => {
    if (queuePersister) await queuePersister();
  });
  onShutdown("close", () => booted.close());
}
