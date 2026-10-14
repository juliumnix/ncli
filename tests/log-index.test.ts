import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LogIndex, MSG_PAGE } from "../src/memory/log-index";
import { Memory, mockCompressor } from "../src/memory/store";
import { serve } from "../src/server";
import { makeHub, tmpDir } from "./helpers";

function memAt(dir: string): Memory {
  return new Memory({ dir, nodeBytes: 200, viewBytes: 800, compressor: mockCompressor() });
}

function writeLog(dir: string, n: number, extra = "") {
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify({
    i,
    kind: i % 2 === 0 ? "user" : "talk",
    text: extra && i === 0 ? `${extra} primeira` : `linha ${i} **md**`,
    size: 20,
    date: `2024-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));
  writeFileSync(join(dir, "log.jsonl"), `${lines.join("\n")}\n`);
}

test("LogIndex pages from disk without a Memory log", async () => {
  const dir = tmpDir("log-idx");
  writeLog(dir, 250, "OLÁ");
  const idx = new LogIndex(dir);
  await idx.rebuild();
  expect(idx.count).toBe(250);
  const last = await idx.page({ limit: 100 });
  expect(last.messages.length).toBe(100);
  expect(last.messages[0]?.i).toBe(150);
  expect(last.messages.at(-1)?.i).toBe(249);
  expect(last.before).toBe(150);
  expect(last.hasMoreBefore).toBe(true);
  const older = await idx.page({ before: 150, limit: 100 });
  expect(older.messages[0]?.i).toBe(50);
  expect(older.messages.at(-1)?.i).toBe(149);
  const first = await idx.page({ after: 0, limit: 40 });
  expect(first.messages[0]?.i).toBe(0);
  expect(first.messages[0]?.text).toContain("primeira");
  const around = await idx.page({ around: 0, limit: 40 });
  expect(around.messages[0]?.i).toBe(0);
  const hits = await idx.search("OLÁ");
  expect(hits[0]?.i).toBe(0);
  expect(idx.firstOnOrAfter("2024-01-02")).toBeGreaterThanOrEqual(0);
});

test("GET /api/messages reads by cursor and search", async () => {
  const { hub } = await makeHub();
  hub.cfg.port = 0;
  writeLog(hub.memory.dir, 300, "MARCA");
  await hub.memory.logIndex.rebuild();
  const server = serve(hub, hub.cfg, join(import.meta.dir, "../public"));
  try {
    const page = await (await fetch(`http://127.0.0.1:${server.port}/api/messages?before=120&limit=40`)).json() as {
      messages: Array<{ i: number }>;
      before: number | null;
    };
    expect(page.messages.length).toBe(40);
    expect(page.messages[0]?.i).toBe(80);
    expect(page.messages.at(-1)?.i).toBe(119);
    const hits = await (await fetch(`http://127.0.0.1:${server.port}/api/messages/search?q=MARCA`)).json() as {
      hits: Array<{ i: number }>;
    };
    expect(hits.hits[0]?.i).toBe(0);
    const meta = await (await fetch(`http://127.0.0.1:${server.port}/api/messages/meta`)).json() as {
      messageCount: number;
    };
    expect(meta.messageCount).toBe(300);
    expect(MSG_PAGE).toBe(100);
  } finally {
    server.stop(true);
    hub.close();
  }
});

test("a second boot keeps offsets.bin when the index is already fresh", async () => {
  const { hub, dataDir } = await makeHub();
  hub.memory.ingest(
    Array.from({ length: 120 }, (_, i) => ({ kind: "user" as const, text: `n ${i}` })),
    { quiet: true },
  );
  const bin = join(dataDir, "main", "log.offsets.bin");
  const before = readFileSync(bin);
  hub.close();
  const again = await makeHub({ dataDir });
  try {
    expect(Buffer.compare(before, readFileSync(bin))).toBe(0);
    expect(again.hub.memory.log.length).toBe(120);
    expect(again.hub.memory.logIndex.count).toBe(120);
    expect(again.hub.memory.logIndex.stale()).toBe(false);
  } finally {
    again.hub.close();
  }
});

test("a crash after 100 appends rebuilds the index past the 64-line persist", async () => {
  const dir = tmpDir("idx-crash");
  const first = memAt(dir);
  for (let i = 0; i < 100; i++) first.append({ kind: "user", text: `n ${i}` });
  expect(first.log.length).toBe(100);
  const again = memAt(dir);
  expect(again.logIndex.count).toBe(100);
  expect(again.logIndex.stale()).toBe(false);
  const last = await again.logIndex.page({ limit: 10 });
  expect(last.messageCount).toBe(100);
  expect(last.messages.length).toBe(10);
  expect(last.messages[0]?.i).toBe(90);
  expect(last.messages.at(-1)?.i).toBe(99);
});

test("a log shrunk from 50 to 5 rebuilds instead of paging empty", async () => {
  const dir = tmpDir("idx-shrink");
  memAt(dir).ingest(Array.from({ length: 50 }, (_, i) => ({ kind: "user" as const, text: `n ${i}` })));
  writeLog(dir, 5);
  const again = memAt(dir);
  expect(again.logIndex.count).toBe(5);
  const page = await again.logIndex.page({});
  expect(page.messageCount).toBe(5);
  expect(page.messages.length).toBe(5);
  expect(page.messages.map((m) => m.i)).toEqual([0, 1, 2, 3, 4]);
});

test("load keeps a last line without a newline and the next append gets a new id", () => {
  const dir = tmpDir("idx-nl");
  const first = memAt(dir);
  first.append({ kind: "user", text: "a" });
  first.append({ kind: "user", text: "b" });
  const path = join(dir, "log.jsonl");
  writeFileSync(path, readFileSync(path, "utf8").replace(/\n$/, ""));
  const again = memAt(dir);
  expect(again.log.length).toBe(2);
  expect(again.log.map((m) => m.i)).toEqual([0, 1]);
  const added = again.append({ kind: "user", text: "c" });
  expect(added.i).toBe(2);
  expect(again.log.map((m) => m.i)).toEqual([0, 1, 2]);
  const file = readFileSync(path, "utf8");
  expect(file.endsWith("\n")).toBe(true);
  const ids = file.trimEnd().split("\n").map((line) => (JSON.parse(line) as { i: number }).i);
  expect(ids).toEqual([0, 1, 2]);
  expect(file).not.toContain("}{");
});

test("a valid index skips the log on load and pages the last window", async () => {
  const dir = tmpDir("idx-skip-log");
  const n = 100_000;
  writeLog(dir, n);
  const built = new LogIndex(dir);
  built.rebuildSync();
  expect(built.count).toBe(n);
  const bin = readFileSync(join(dir, "log.offsets.bin"));
  expect(bin.readUInt32LE(4)).toBe(n);
  expect(bin.length).toBe(12 + n * 4);
  const t0 = performance.now();
  const mem = memAt(dir);
  const ms = performance.now() - t0;
  expect(mem.log.length).toBe(0);
  expect(mem.logIndex.count).toBe(n);
  expect(mem.logIndex.stale()).toBe(false);
  expect(ms).toBeLessThan(50);
  const page = await mem.logIndex.page({ limit: 80 });
  expect(page.messages.length).toBe(80);
  expect(page.messages[0]?.i).toBe(n - 80);
  expect(page.messages.at(-1)?.i).toBe(n - 1);
  expect(page.hasMoreBefore).toBe(true);
});

test("ingest stringifies each message once", () => {
  const store = readFileSync(join(import.meta.dir, "../src/memory/store.ts"), "utf8");
  const ingest = store.slice(store.indexOf("ingest(partials"), store.indexOf("publish():"));
  expect(ingest).toContain("const lines = out.map");
  expect(ingest).toContain("Buffer.byteLength(lines[k]");
  expect(ingest).not.toMatch(/out\.map\(\(msg\) => `\$\{JSON\.stringify\(msg\)\}\\n`\)\.join/);
  const load = store.slice(store.indexOf("private load()"), store.indexOf("if (existsSync(treePath)"));
  expect(load).toContain("const fresh");
  expect(load).toContain("if (!fresh)");
  expect(load).toContain("this.logIndex.count <= 2000");
  expect(load).toContain("this.parseLog(logPath)");
});
