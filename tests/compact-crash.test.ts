import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { cursorCompressor } from "../src/memory/cursor-compact";
import { sdkFailMessage } from "../src/memory/sdk-compact";
import { Memory } from "../src/memory/store";
import { makeHub, tmpDir } from "./helpers";

const LONG = "user decided FACT_MEMBER_DISCOUNT_BEFORE_TAX applies only to member and before tax. ".repeat(6);

test("sdkFailMessage includes status, code, and body", () => {
  expect(sdkFailMessage({ status: "error", error: { code: "rate_limited", message: "model overloaded" } })).toBe(
    "cursor-sdk compact run failed (error: rate_limited: model overloaded)",
  );
  expect(sdkFailMessage({ status: "cancelled" })).toBe("cursor-sdk compact run failed (cancelled)");
  expect(sdkFailMessage({})).toBe("cursor-sdk compact run failed (unknown)");
});

test("a cursor-sdk compact throw does not fail Memory.pump and surfaces the error", async () => {
  const dir = tmpDir("compact-crash");
  const seen: string[] = [];
  const compact = cursorCompressor(
    loadConfig({
      dataDir: dir,
      compactBackend: "cursor",
      compactBatch: 1,
      compactDebounceMs: 5,
      compactSkipTokens: 1,
      compactTries: 8,
    }),
    async () => {
      throw new Error("cursor-sdk compact run failed (error: rate_limited: model overloaded)");
    },
    (ev) => {
      if (ev.error) seen.push(ev.error);
    },
  );
  const mem = new Memory({
    dir: join(dir, "mem"),
    nodeBytes: 80,
    viewBytes: 200,
    compressor: compact,
    deferBackoffMs: 30_000,
    deferCutAfter: 8,
  });
  mem.append({ kind: "user", text: LONG });
  await mem.pump();
  expect(seen.some((e) => e.includes("rate_limited"))).toBe(true);
  expect(mem.nodeOf(0, 0)?.text).toBeUndefined();
  mem.paused = true;
});

test("a compact SDK throw leaves the hub up so the next chat turn still runs", async () => {
  const { hub } = await makeHub({ nodeBytes: 40, viewBytes: 800 });
  hub.memory.compressor = async () => {
    throw new Error("cursor-sdk compact run failed");
  };
  hub.memory.append({ kind: "user", text: LONG });
  await hub.memory.pump();
  await hub.send("oi depois da compactacao");
  expect(hub.snapshot().turning).toBe(false);
  expect(hub.memory.log.some((m) => m.kind === "talk")).toBe(true);
  hub.close();
});

test("provider compact errors retry with backoff instead of crashing pump", async () => {
  let calls = 0;
  const mem = new Memory({
    dir: tmpDir("compact-defer"),
    nodeBytes: 40,
    viewBytes: 200,
    deferBackoffMs: 15,
    deferCutAfter: 8,
    compressor: async () => {
      calls += 1;
      throw new Error("cursor-sdk compact run failed");
    },
  });
  mem.append({ kind: "user", text: LONG });
  await mem.pump();
  expect(calls).toBe(1);
  await Bun.sleep(80);
  await mem.pump();
  expect(calls).toBeGreaterThan(1);
  expect(mem.nodeOf(0, 0)?.text).toBeUndefined();
  mem.paused = true;
});
