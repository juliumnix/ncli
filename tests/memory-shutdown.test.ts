import { expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CompactHold } from "../src/memory/compact-deferred";
import { COMPACT_QUEUE_FILE, loadCompactQueue } from "../src/memory/compact-queue";
import { Memory } from "../src/memory/store";
import { tmpDir } from "./helpers";

const LONG = "marcador-shutdown FACT_MEMBER_DISCOUNT_BEFORE_TAX applies. ".repeat(8);

test("Memory.shutdown flushes treeBuf, saves view.json, and writes compact-queue.json", async () => {
  const dir = join(tmpDir("mem-shutdown"), "mem");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const mem = new Memory({
    dir,
    nodeBytes: 40,
    viewBytes: 4000,
    compactJobs: 4,
    pumpBatch: 1,
    compressor: async () => {
      calls += 1;
      if (calls % 2 === 0) await gate;
      return `sum ${calls}`.slice(0, 30);
    },
  });
  const first = mem.append({ kind: "user", text: LONG });
  for (let k = 0; k < 6; k++) mem.append({ kind: "user", text: `linha ${k} ${LONG}` });
  const deadline = Date.now() + 3000;
  while (mem["treeBuf"].length === 0 && Date.now() < deadline) await Bun.sleep(5);
  const buffered = mem["treeBuf"].map((n) => Memory.key(n.l, n.i));
  expect(buffered.length).toBeGreaterThan(0);

  const qPath = join(dir, COMPACT_QUEUE_FILE);
  if (existsSync(qPath)) unlinkSync(qPath);
  mem.paused = true;
  mem.shutdown();
  release();

  expect(mem["treeBuf"]).toEqual([]);
  const viewPath = join(dir, "view.json");
  expect(existsSync(viewPath)).toBe(true);
  expect(existsSync(`${viewPath}.tmp`)).toBe(false);
  const view = JSON.parse(readFileSync(viewPath, "utf8")) as { parts: unknown[] };
  expect(view.parts.length).toBeGreaterThan(0);

  const jobs = loadCompactQueue(dir);
  expect(jobs === null ? 0 : jobs.length).toBeGreaterThan(0);
  expect((jobs ?? []).every((j) => typeof j.last === "number" && j.hash.length > 0)).toBe(true);

  const tree = readFileSync(join(dir, "tree.jsonl"), "utf8");
  expect(tree.endsWith("\n")).toBe(true);
  for (const line of tree.split("\n").filter(Boolean)) JSON.parse(line);

  const again = new Memory({ dir, nodeBytes: 40, viewBytes: 4000, compressor: async () => "x" });
  again.paused = true;
  for (const key of buffered) {
    const [l, i] = key.split(":").map(Number);
    expect(again.nodeOf(l, i)).toBeDefined();
  }
  expect(again.recall("marcador-shutdown").some((line) => line.startsWith(`#${first.i} `))).toBe(true);
});

test("Memory.shutdown rewrites a deleted compact-queue.json from the live refine queue", async () => {
  const dir = join(tmpDir("mem-shutdown-q"), "mem");
  const mem = new Memory({
    dir,
    nodeBytes: 40,
    viewBytes: 400,
    compressor: async () => {
      throw new CompactHold("limit");
    },
  });
  mem.append({ kind: "user", text: LONG });
  await mem.pump();
  expect(mem.compactWork.paused).toBe("limit");
  const before = loadCompactQueue(dir);
  expect(before === null ? 0 : before.length).toBeGreaterThan(0);

  unlinkSync(join(dir, COMPACT_QUEUE_FILE));
  expect(loadCompactQueue(dir)).toBeNull();
  mem.shutdown();
  const after = loadCompactQueue(dir);
  expect(after).toEqual(before);
  mem.paused = true;
});
