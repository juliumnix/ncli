import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { serve } from "../src/server";
import { STATE_PAGE } from "../src/state-page";
import { makeHub } from "./helpers";

function seedLog(hub: Awaited<ReturnType<typeof makeHub>>["hub"], n = 6600) {
  hub.memory.ingest(
    Array.from({ length: n }, (_, i) => ({
      kind: (i % 2 === 0 ? "user" : "talk") as "user" | "talk",
      text: `linha ${i} **md**`,
    })),
  );
}

test("STATE_PAGE is the chat window size", () => {
  expect(STATE_PAGE).toBe(80);
});

test("snapshot windows the last 80 of 6600 and drops forks and waiting", async () => {
  const { hub } = await makeHub();
  try {
    seedLog(hub);
    const snap = hub.snapshot();
    expect(hub.memory.log.length).toBe(6600);
    expect(snap.messages.length).toBe(STATE_PAGE);
    expect(snap.messages[0]?.i).toBe(6600 - STATE_PAGE);
    expect(snap.messages.at(-1)?.i).toBe(6599);
    expect(snap.messageCount).toBe(6600);
    expect(snap.hasMore).toBe(true);
    expect(snap.before).toBe(6600 - STATE_PAGE);
    expect(snap.forks).toBeUndefined();
    expect(snap.waiting).toBeUndefined();
    expect(Array.isArray(snap.sparks)).toBe(true);
  } finally {
    hub.close();
  }
});

test("snapshot({ before }) returns the previous page", async () => {
  const { hub } = await makeHub();
  try {
    seedLog(hub);
    const first = hub.snapshot();
    const older = hub.snapshot({ before: first.before ?? 0 });
    expect(older.messages.length).toBe(STATE_PAGE);
    expect(older.messages.at(-1)?.i).toBe((first.before ?? 0) - 1);
    expect(older.hasMore).toBe(true);
    expect(older.before).toBe(6600 - STATE_PAGE * 2);
  } finally {
    hub.close();
  }
});

test("GET /api/state payload stays under 200KB with 6600 messages", async () => {
  const { hub } = await makeHub();
  hub.cfg.port = 0;
  const server = serve(hub, hub.cfg, join(import.meta.dir, "../public"));
  try {
    seedLog(hub);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state`);
    expect(res.ok).toBe(true);
    const buf = Buffer.from(await res.arrayBuffer());
    const body = JSON.parse(buf.toString("utf8")) as {
      messages: Array<{ i: number }>;
      messageCount: number;
      hasMore: boolean;
      before: number | null;
      forks?: unknown;
      waiting?: unknown;
    };
    expect(body.messages.length).toBe(STATE_PAGE);
    expect(body.messageCount).toBe(6600);
    expect(body.hasMore).toBe(true);
    expect(body.forks).toBeUndefined();
    expect(body.waiting).toBeUndefined();
    expect(buf.byteLength).toBeLessThan(200 * 1024);
  } finally {
    server.stop(true);
    hub.close();
  }
});

test("GET /api/state?before= pages older messages", async () => {
  const { hub } = await makeHub();
  hub.cfg.port = 0;
  const server = serve(hub, hub.cfg, join(import.meta.dir, "../public"));
  try {
    seedLog(hub, 200);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state?before=120&limit=40`);
    const body = (await res.json()) as { messages: Array<{ i: number }>; before: number | null; hasMore: boolean };
    expect(body.messages.length).toBe(40);
    expect(body.messages[0]?.i).toBe(80);
    expect(body.messages.at(-1)?.i).toBe(119);
    expect(body.before).toBe(80);
    expect(body.hasMore).toBe(true);
  } finally {
    server.stop(true);
    hub.close();
  }
});

test("/api/state rereads the log only when the index is ahead of memory", () => {
  const server = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
  const route = server.slice(server.indexOf('pathname === "/api/state"'), server.indexOf('pathname === "/api/message"'));
  expect(route).toContain("hub.snapshot");
  expect(route).toContain("return Response.json(snap)");
  expect(route).toContain("logIndex.count > hub.memory.log.length");
  expect(route.indexOf("logIndex.count > hub.memory.log.length")).toBeLessThan(route.indexOf("messagesPage"));
});

test("GET /api/state serves the last index page when memory is empty", async () => {
  const { hub } = await makeHub();
  const n = 240;
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify({
    i,
    kind: i % 2 === 0 ? "user" : "talk",
    text: `linha ${i}`,
    size: 16,
    date: "2020-01-01T00:00:00.000Z",
  }));
  writeFileSync(join(hub.memory.dir, "log.jsonl"), `${lines.join("\n")}\n`);
  await hub.memory.logIndex.rebuild();
  expect(hub.memory.log.length).toBe(0);
  expect(hub.memory.logIndex.count).toBe(n);
  hub.cfg.port = 0;
  const server = serve(hub, hub.cfg, join(import.meta.dir, "../public"));
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state`);
    const body = (await res.json()) as {
      messages: Array<{ i: number }>;
      messageCount: number;
      hasMore: boolean;
    };
    expect(body.messageCount).toBe(n);
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.messages.length).toBeLessThanOrEqual(STATE_PAGE);
    expect(body.messages.at(-1)?.i).toBe(n - 1);
    expect(body.hasMore).toBe(true);
  } finally {
    server.stop(true);
    hub.close();
  }
});

test("GET /api/state after ingest stays on the memory page", async () => {
  const { hub } = await makeHub();
  hub.cfg.port = 0;
  const server = serve(hub, hub.cfg, join(import.meta.dir, "../public"));
  try {
    seedLog(hub, 6600);
    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state`);
    const ms = performance.now() - t0;
    const body = (await res.json()) as { messages: unknown[]; messageCount: number };
    expect(body.messageCount).toBe(6600);
    expect(body.messages.length).toBe(STATE_PAGE);
    expect(ms).toBeLessThan(250);
  } finally {
    server.stop(true);
    hub.close();
  }
});

test("app.js syncs chat by data-mid and never wipes the log", () => {
  const app = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  expect(app).toContain("function syncChat");
  expect(app).toContain("rowHtmlCache");
  expect(app).toContain("loadOlder");
  expect(app).not.toMatch(/log\.innerHTML = parts\.join/);
  expect(app).not.toMatch(/log\.innerHTML = built\.html/);
  const spark = app.slice(app.indexOf('case "spark"'), app.indexOf('case "views"'));
  expect(spark).toContain("renderShortcuts()");
  expect(spark).not.toContain("renderChat()");
  expect(spark).not.toContain("scheduleFullPaint()");
});

test("bootNcli serves a windowed first page", async () => {
  const { hub } = await makeHub();
  seedLog(hub);
  hub.cfg.port = 17400 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: join(import.meta.dir, "..") });
  try {
    const res = await fetch(`${booted.report.uiUrl}/api/state`);
    const buf = Buffer.from(await res.arrayBuffer());
    const body = JSON.parse(buf.toString("utf8")) as {
      messages: unknown[];
      messageCount: number;
    };
    expect(body.messageCount).toBe(6600);
    expect(body.messages.length).toBe(STATE_PAGE);
    expect(buf.byteLength).toBeLessThan(200 * 1024);
  } finally {
    booted.stop();
    hub.close();
  }
});
