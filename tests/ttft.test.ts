import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { Hub } from "../src/hub";
import { MockHarness } from "../src/harness/mock";
import { initTempRepo } from "../src/sparks/worktree";
import { CompactDeferred } from "../src/memory/compact-deferred";
import { Memory } from "../src/memory/store";
import { makeHub, tmpDir } from "./helpers";

const LONG = "user decided the alpha file lives at /tmp/ncli/alpha.json. ".repeat(8);

test("exhausted compact budget does not delay the first token and writes no compacting note", async () => {
  const dataDir = tmpDir("ttft-budget");
  writeFileSync(join(dataDir, "compact-budget.json"), JSON.stringify({
    day: new Date().toISOString().slice(0, 10),
    tokens: 30,
    calls: 4,
  }));
  const repo = await initTempRepo("ttft");
  const harness = new MockHarness(() => ({ text: "ok rápido" }));
  const cfg = loadConfig({
    dataDir,
    repo,
    ncliRoot: join(import.meta.dir, ".."),
    harness: "mock",
    compactBackend: "cursor",
    compactBudgetTokens: 30,
    compactSkipTokens: 1,
    compactDebounceMs: 2500,
    compactTries: 3,
    viewBytes: 800,
    nodeBytes: 140,
    port: 47231,
    demo: false,
    ghMode: "mock",
  });
  const hub = new Hub(cfg, join(import.meta.dir, "../views"), join(import.meta.dir, "../fixtures/gh"), harness);
  await hub.start();
  try {
    hub.memory.append({ kind: "user", text: LONG });
    await Bun.sleep(30);
    let firstDelta = 0;
    const t0 = performance.now();
    const off = hub.subscribe((ev) => {
      if (ev.type === "delta" && ev.text && !firstDelta) firstDelta = performance.now();
    });
    await hub.send("oi depois do orçamento");
    off();
    const ttft = (firstDelta || performance.now()) - t0;
    expect(ttft).toBeLessThan(600);
    expect(hub.memory.log.some((m) => m.text.includes("memória ainda compactando"))).toBe(false);
    expect(harness.lastPrompts.at(-1)).toContain("oi depois do orçamento");
  } finally {
    hub.close();
  }
});

test("stop aborts an in-flight compact wait before the settle cap", async () => {
  const mem = new Memory({
    dir: tmpDir("ttft-abort-mem"),
    nodeBytes: 40,
    viewBytes: 800,
    compressTimeoutMs: 0,
    compressor: () => new Promise(() => undefined),
  });
  mem.append({ kind: "user", text: LONG });
  const ac = new AbortController();
  const wait = mem.waitForInFlight({ timeoutMs: 5_000, signal: ac.signal });
  const t0 = performance.now();
  ac.abort();
  await wait;
  expect(performance.now() - t0).toBeLessThan(200);

  const dataDir = tmpDir("ttft-abort");
  writeFileSync(join(dataDir, "compact-budget.json"), JSON.stringify({
    day: new Date().toISOString().slice(0, 10),
    tokens: 30,
    calls: 4,
  }));
  const repo = await initTempRepo("ttft-abort");
  const harness = new MockHarness(() => ({ text: "depois do stop" }));
  const cfg = loadConfig({
    dataDir,
    repo,
    ncliRoot: join(import.meta.dir, ".."),
    harness: "mock",
    compactBackend: "cursor",
    compactSkipTokens: 1,
    compactDebounceMs: 2500,
    compactBudgetTokens: 30,
    viewBytes: 800,
    nodeBytes: 140,
    port: 47231,
    demo: false,
    ghMode: "mock",
  });
  const hub = new Hub(cfg, join(import.meta.dir, "../views"), join(import.meta.dir, "../fixtures/gh"), harness);
  await hub.start();
  try {
    const send = hub.send(LONG);
    await Bun.sleep(15);
    const t0Hub = performance.now();
    hub.stopTurn();
    await send;
    expect(performance.now() - t0Hub).toBeLessThan(250);
    expect(hub.memory.log.some((m) => m.text.includes("turno interrompido"))).toBe(true);
  } finally {
    hub.close();
  }
});

test("an in-flight compact from the previous answer does not delay the next turn", async () => {
  const prev = process.env.NCLI_COMPACT_DELAY;
  process.env.NCLI_COMPACT_DELAY = "2000";
  try {
    const { hub } = await makeHub({ nodeBytes: 40, viewBytes: 800 });
    try {
      hub.memory.append({ kind: "user", text: LONG });
      await Bun.sleep(20);
      expect(hub.memory.hasInFlight()).toBe(true);
      let firstDelta = 0;
      const t0 = performance.now();
      const off = hub.subscribe((ev) => {
        if (ev.type === "delta" && ev.text && !firstDelta) firstDelta = performance.now();
      });
      await hub.send("oi depois da compactacao");
      off();
      const ttft = (firstDelta || performance.now()) - t0;
      expect(ttft).toBeLessThan(400);
    } finally {
      hub.close();
    }
  } finally {
    if (prev === undefined) delete process.env.NCLI_COMPACT_DELAY;
    else process.env.NCLI_COMPACT_DELAY = prev;
  }
});

test("waitForInFlight returns now when only deferred nodes remain", async () => {
  const mem = new Memory({
    dir: tmpDir("ttft-deferred"),
    nodeBytes: 40,
    viewBytes: 800,
    deferBackoffMs: 5_000,
    deferCutAfter: 8,
    compressor: async () => {
      throw new CompactDeferred();
    },
  });
  mem.append({ kind: "user", text: `pending ${"z".repeat(80)}` });
  await mem.pump();
  expect(mem.hasInFlight()).toBe(false);
  const t0 = performance.now();
  const ok = await mem.waitForInFlight({ timeoutMs: 400 });
  expect(performance.now() - t0).toBeLessThan(50);
  expect(ok).toBe(false);
  expect(mem.debug().budget).toBe(mem.viewHigh);
});
