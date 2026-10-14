import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Booted } from "../src/boot";
import { registerBootShutdown, setQueuePersister } from "../src/boot-shutdown";
import { loadCompactQueue } from "../src/memory/compact-queue";
import { Memory } from "../src/memory/store";
import { installChildShutdown, resetShutdownForTest, runShutdown, setHarnessKiller } from "../src/shutdown";
import { tmpDir } from "./helpers";

afterEach(() => {
  resetShutdownForTest();
  setQueuePersister(undefined);
});

function fakeBooted(mem: Memory, close: () => void | Promise<void> = async () => {}, sparks: Memory[] = []): Booted {
  return {
    hub: {
      memory: mem,
      sparks: { runtimes: new Map(), sparkMemories: () => sparks },
      engine: { killAll: async () => {} },
    },
    stop: () => {},
    close,
  } as unknown as Booted;
}

async function fillTree(dir: string): Promise<{ mem: Memory; keys: string[]; release: () => void }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const mem = new Memory({
    dir,
    nodeBytes: 40,
    viewBytes: 4000,
    compactJobs: 4,
    compressor: async () => {
      calls += 1;
      if (calls % 2 === 0) await gate;
      return `sum ${calls}`.slice(0, 30);
    },
  });
  mem.append({ kind: "user", text: "marcador-irmao ".repeat(20) });
  for (let k = 0; k < 6; k++) mem.append({ kind: "user", text: `linha ${k} `.repeat(20) });
  const deadline = Date.now() + 3000;
  while (mem["treeBuf"].length === 0 && Date.now() < deadline) await Bun.sleep(5);
  const keys = mem["treeBuf"].map((n) => Memory.key(n.l, n.i));
  expect(keys.length).toBeGreaterThan(0);
  return { mem, keys, release };
}

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
      if (calls % 2 === 0) await gate;
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
  registerBootShutdown(fakeBooted(mem));
  setQueuePersister(() => {
    queued += 1;
  });
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

test("one shutdown path: flush, harness, compactor, queue, close in order, one SIGINT listener", async () => {
  const mem = new Memory({ dir: join(tmpDir(), "mem"), nodeBytes: 80, viewBytes: 200, compressor: async () => "x" });
  const order: string[] = [];
  const flushTree = mem["flushTree"].bind(mem);
  const saveView = mem["saveView"].bind(mem);
  Object.defineProperty(mem, "flushTree", { value: () => (order.push("flush"), flushTree()) });
  Object.defineProperty(mem, "saveView", { value: () => (order.push("saveView"), saveView()) });
  const others = process.listeners("SIGINT");
  process.removeAllListeners("SIGINT");
  const stop = installChildShutdown({ exit: () => {} });
  const booted = fakeBooted(mem, async () => {
    await Bun.sleep(20);
    order.push("close");
  });
  booted.hub.engine.killAll = async () => {
    order.push("compactor");
  };
  registerBootShutdown(booted);
  expect(process.listenerCount("SIGINT")).toBe(1);
  setHarnessKiller(async (ms) => {
    expect(ms).toBe(2000);
    await Bun.sleep(20);
    order.push("harness");
  });
  setQueuePersister(() => {
    order.push("queue");
  });
  await runShutdown("test");
  stop();
  for (const l of others) process.on("SIGINT", l as () => void);
  expect(order).toEqual(["flush", "saveView", "harness", "compactor", "queue", "close"]);
});

test("one memory flushTree throw still writes the others' tree.jsonl and view.json", async () => {
  const root = tmpDir("mem-isolate");
  const broken = new Memory({
    dir: join(root, "broken"),
    nodeBytes: 80,
    viewBytes: 400,
    compressor: async () => "x",
  });
  Object.defineProperty(broken, "flushTree", {
    value: () => {
      throw new Error("flush boom");
    },
  });
  broken.append({ kind: "user", text: "quebrado" });
  const a = await fillTree(join(root, "spark-a"));
  const b = await fillTree(join(root, "spark-b"));
  for (const mem of [a.mem, b.mem]) {
    const view = join(mem.dir, "view.json");
    if (existsSync(view)) unlinkSync(view);
  }
  registerBootShutdown(fakeBooted(broken, async () => {}, [a.mem, b.mem]));
  await runShutdown("test");
  a.release();
  b.release();
  for (const { mem, keys } of [a, b]) {
    const tree = readFileSync(join(mem.dir, "tree.jsonl"), "utf8");
    expect(tree.endsWith("\n")).toBe(true);
    const lines = tree.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { l: number; i: number });
    for (const key of keys) {
      const [l, i] = key.split(":").map(Number);
      expect(lines.some((n) => n.l === l && n.i === i)).toBe(true);
    }
    const viewPath = join(mem.dir, "view.json");
    expect(existsSync(viewPath)).toBe(true);
    const view = JSON.parse(readFileSync(viewPath, "utf8")) as { parts: Array<{ l: number; i: number }> };
    expect(view.parts.length).toBeGreaterThan(0);
  }
});

test("SIGTERM mid hung compact writes the killed job to compact-queue.json and the next boot redoes it", async () => {
  const dir = join(tmpDir("hung-compact"), "mem");
  const LONG = "marcador-requeue FACT_KILL_IN_FLIGHT_MUST_RETURN applies. ".repeat(8);
  let rejectHang!: (err: Error) => void;
  const hung = new Promise<never>((_, reject) => {
    rejectHang = reject;
  });
  const mem = new Memory({
    dir,
    nodeBytes: 40,
    viewBytes: 4000,
    compactJobs: 1,
    pumpBatch: 1,
    compressTimeoutMs: 0,
    compressor: async () => hung,
  });
  mem.append({ kind: "user", text: LONG });
  const deadline = Date.now() + 3000;
  while (mem["busy"].size === 0 && Date.now() < deadline) await Bun.sleep(5);
  const inFlight = [...mem["busy"]] as string[];
  expect(inFlight.length).toBeGreaterThan(0);

  registerBootShutdown(fakeBooted(mem));
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
  expect(await exited).toBe(143);
  for (const l of others) process.on("SIGTERM", l as () => void);
  rejectHang(new Error("killed"));

  const jobs = loadCompactQueue(dir);
  expect(jobs === null ? 0 : jobs.length).toBeGreaterThan(0);
  for (const key of inFlight) {
    const [l, i] = key.split(":").map(Number);
    expect(jobs!.some((job) => job.l === l && job.i === i)).toBe(true);
  }

  let redone = 0;
  const again = new Memory({
    dir,
    nodeBytes: 40,
    viewBytes: 4000,
    compactJobs: 1,
    pumpBatch: 1,
    compressor: async () => {
      redone += 1;
      return { text: "REDO_OK", compactor: "cli" as const, agent: "codex", model: "mini" };
    },
  });
  await again.pump();
  expect(redone).toBeGreaterThan(0);
  for (const key of inFlight) {
    const [l, i] = key.split(":").map(Number);
    expect(again.nodeOf(l, i)?.compactor).toBe("cli");
  }
  again.paused = true;
});
