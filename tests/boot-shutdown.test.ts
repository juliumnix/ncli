import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Booted } from "../src/boot";
import { memoryHooks, registerBootShutdown, setQueuePersister } from "../src/boot-shutdown";
import { Memory } from "../src/memory/store";
import { installChildShutdown, resetShutdownForTest } from "../src/shutdown";
import { tmpDir } from "./helpers";

afterEach(() => {
  resetShutdownForTest();
  setQueuePersister(undefined);
});

function fakeBooted(mem: Memory): Booted {
  return { hub: { memory: mem, sparks: { runtimes: new Map() } }, stop: () => {} } as unknown as Booted;
}

test("a real Memory exposes flushTree and saveView as functions (renaming either turns this red)", () => {
  const mem = new Memory({ dir: join(tmpDir(), "mem"), nodeBytes: 80, viewBytes: 200, compressor: async () => "x" });
  expect(typeof mem["flushTree"]).toBe("function");
  expect(typeof mem["saveView"]).toBe("function");
  expect(() => memoryHooks(mem)).not.toThrow();
  mem.paused = true;
});

test("registerBootShutdown fails loud at boot when flushTree is missing", () => {
  const mem = new Memory({ dir: join(tmpDir(), "mem"), nodeBytes: 80, viewBytes: 200, compressor: async () => "x" });
  mem.paused = true;
  Object.defineProperty(mem, "flushTree", { value: undefined });
  expect(() => registerBootShutdown(fakeBooted(mem))).toThrow(/flushTree is not a function/);
});

test("SIGTERM mid muted batch persists treeBuf, leaves whole jsonl lines, and recall finds the earlier id", async () => {
  const dir = join(tmpDir(), "mem");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const mem = new Memory({
    dir,
    nodeBytes: 40,
    viewBytes: 4000,
    compactJobs: 4,
    compressor: async (input) => {
      calls += 1;
      if (calls % 2 === 0) await gate; // hold muteChange across an await while siblings land
      return `sum ${String((input as { l?: number }).l ?? "")} ${calls}`.slice(0, 30);
    },
  });
  const first = mem.append({ kind: "user", text: "marcador-zebra ".repeat(20) });
  for (let k = 0; k < 6; k++) mem.append({ kind: "user", text: `linha ${k} `.repeat(20) });
  const deadline = Date.now() + 3000;
  while (mem["treeBuf"].length === 0 && Date.now() < deadline) await Bun.sleep(5);
  const buffered = mem["treeBuf"].map((n) => Memory.key(n.l, n.i));
  expect(buffered.length).toBeGreaterThan(0);
  expect(mem["muteChange"]).toBe(true);

  let queued = 0;
  setQueuePersister(() => {
    queued += 1;
  });
  registerBootShutdown(fakeBooted(mem));
  // Isolate from SIGTERM listeners other test files in this process may have installed.
  const others = process.listeners("SIGTERM");
  process.removeAllListeners("SIGTERM");
  const exited = new Promise<number>((resolve) => {
    const stop = installChildShutdown({
      exit: (code) => {
        stop();
        resolve(code);
      },
    });
  });
  process.kill(process.pid, "SIGTERM");
  const code = await exited;
  for (const l of others) process.on("SIGTERM", l as () => void);
  expect(code).toBe(143);
  expect(queued).toBe(1);
  release();

  for (const f of ["log.jsonl", "tree.jsonl"]) {
    const raw = readFileSync(join(dir, f), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    for (const line of raw.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  }
  const again = new Memory({ dir, nodeBytes: 40, viewBytes: 4000, compressor: async () => "x" });
  again.paused = true;
  for (const key of buffered) {
    const [l, i] = key.split(":").map(Number);
    expect(again.nodeOf(l, i)).toBeDefined();
  }
  expect(again.recall("marcador-zebra").some((line) => line.startsWith(`#${first.i} `))).toBe(true);
});
