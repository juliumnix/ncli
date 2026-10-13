import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LogIndex, MSG_PAGE } from "../src/memory/log-index";
import { serve } from "../src/server";
import { makeHub, tmpDir } from "./helpers";

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
