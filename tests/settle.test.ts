import { expect, test } from "bun:test";
import { assemble } from "../src/memory/assemble";
import { CompactDeferred } from "../src/memory/compact-deferred";
import { Memory } from "../src/memory/store";
import { makeHub, tmpDir } from "./helpers";

const PLACEHOLDER = "(not summarized yet: zoom it)";

test("settle waits until every cover line is built and shows no raw excerpt", async () => {
  const mem = new Memory({
    dir: tmpDir("settle"),
    nodeBytes: 40,
    viewBytes: 8000,
    compressor: async (input) => {
      await Bun.sleep(30);
      return input.source.slice(0, 36);
    },
  });
  for (let i = 0; i < 4; i++) {
    mem.append({ kind: "user", text: `long pending user line ${i} ${"x".repeat(80)}` });
  }
  expect(mem.allBuilt()).toBe(false);
  const ok = await mem.settle(5_000);
  expect(ok).toBe(true);
  expect(mem.allBuilt()).toBe(true);
  expect(mem.viewLines().join("\n")).not.toMatch(/user: .{50,}/);
});

test("a settle timeout paints the recipe placeholder, never a raw excerpt", async () => {
  const mem = new Memory({
    dir: tmpDir("settle-timeout"),
    nodeBytes: 40,
    viewBytes: 8000,
    compressTimeoutMs: 0,
    compressor: async () => new Promise(() => undefined),
  });
  mem.append({ kind: "user", text: `pending raw ${"y".repeat(80)}` });
  const ok = await mem.settle(80);
  expect(ok).toBe(false);
  expect(mem.allBuilt()).toBe(false);
  expect(mem.viewLines()).toEqual([`0+1|${PLACEHOLDER}`]);
  expect(assemble(mem).system).toContain(PLACEHOLDER);
  expect(assemble(mem).system).not.toContain("short raw excerpt");
});

test("a burst of raw leaves cannot keep the cover above the 2x ceiling", async () => {
  const mem = new Memory({
    dir: tmpDir("view-cap"),
    nodeBytes: 280,
    viewBytes: 2500,
    compressor: async (input) => {
      if (input.kind === "merge") throw new CompactDeferred();
      return input.source.slice(-280);
    },
  });
  const pad = "padding about billing lint chores and the sprint status of this repo. ".repeat(4);
  for (let i = 0; i < 30; i++) {
    mem.append({ kind: "user", text: `${pad} msg ${i}` });
  }
  await mem.pump();
  mem.fit();
  expect(mem.viewBytesUsed()).toBeLessThanOrEqual(mem.viewHigh);
  expect(assemble(mem).bytes).toBeLessThanOrEqual(mem.viewHigh);
});

test("settle stays registered across notifies until the cover is built", async () => {
  let release!: (s: string) => void;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  const mem = new Memory({
    dir: tmpDir("settle-waiters"),
    nodeBytes: 40,
    viewBytes: 8000,
    compressor: async () => gate,
  });
  mem.append({ kind: "user", text: `long pending ${"x".repeat(80)}` });
  const waiting = mem.settle(5_000);
  await Bun.sleep(20);
  expect(mem.allBuilt()).toBe(false);
  release("done line for the waiter");
  expect(await waiting).toBe(true);
  expect(mem.allBuilt()).toBe(true);
});

test("settle returns when the cover is built even if a parent is still pending", async () => {
  let release!: (s: string) => void;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  const mem = new Memory({
    dir: tmpDir("settle-cover-only"),
    nodeBytes: 40,
    viewBytes: 8000,
    compressor: async (input) => {
      if (input.kind === "merge") return gate;
      return input.source.slice(0, 36);
    },
  });
  for (let i = 0; i < 4; i++) {
    mem.append({ kind: "user", text: `long pending user line ${i} ${"x".repeat(80)}` });
  }
  expect(await mem.settle(5_000)).toBe(true);
  expect(mem.allBuilt()).toBe(true);
  expect(mem.nodeOf(1, 0)).toBeUndefined();
  release("parent line after the cover settled");
  expect(await mem.settleQuiescent(5_000)).toBe(true);
  expect(mem.nodeOf(1, 0)?.text).toContain("parent line");
});

test("a stuck compressor times out and frees the slot", async () => {
  let late = "";
  const mem = new Memory({
    dir: tmpDir("compress-timeout"),
    nodeBytes: 40,
    viewBytes: 8000,
    compressTimeoutMs: 40,
    compressor: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          late = "late line that must not land";
          resolve(late);
        }, 400);
      }),
  });
  mem.append({ kind: "user", text: `pending raw ${"y".repeat(80)}` });
  const t0 = performance.now();
  await mem.pump();
  expect(performance.now() - t0).toBeLessThan(200);
  expect(mem.hasInFlight()).toBe(false);
  expect(mem.deferredCount()).toBeGreaterThan(0);
  expect(mem.nodeOf(0, 0)).toBeUndefined();
  await Bun.sleep(450);
  expect(late).toBe("late line that must not land");
  expect(mem.nodeOf(0, 0)).toBeUndefined();
});

test("the turn prompt is view, then inbox, then the user line", async () => {
  const { hub, harness } = await makeHub();
  try {
    hub.bus.post("codex", "main", "INBOX_SECRET_LINE");
    await hub.send("pergunta do usuario");
    const prompt = harness.lastPrompts.at(-1) ?? "";
    expect(prompt).toContain("<chat>");
    expect(prompt).toContain("INBOX_SECRET_LINE");
    expect(prompt).toContain("pergunta do usuario");
    expect(prompt.indexOf("<chat>")).toBeLessThan(prompt.indexOf("INBOX_SECRET_LINE"));
    expect(prompt.indexOf("INBOX_SECRET_LINE")).toBeLessThan(prompt.indexOf("pergunta do usuario"));
  } finally {
    hub.close();
  }
});
