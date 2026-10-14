import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryHooks } from "../src/boot-shutdown";
import { onShutdown, resetShutdownForTest, runShutdown } from "../src/shutdown";
import { makeHub } from "./helpers";

afterEach(() => {
  resetShutdownForTest();
});

test("an open spark stays in sparkMemories after close", async () => {
  const { hub } = await makeHub();
  try {
    const rt = await hub.sparks.open("refino", { card: "mem-list" });
    expect(hub.sparks.sparkMemories().includes(rt.memory)).toBe(true);
    await hub.sparks.close(rt.spark.id);
    expect(hub.sparks.sparkMemories().includes(rt.memory)).toBe(true);
  } finally {
    await hub.close();
  }
});

test("shutdown flush and queue keep a closed spark line in log.jsonl", async () => {
  const { hub } = await makeHub();
  try {
    const rt = await hub.sparks.open("refino", { card: "mem-flush" });
    rt.memory.append({ kind: "user", text: "SPARK_MEM_FACT" });
    await hub.sparks.close(rt.spark.id);
    onShutdown("flush", () => {
      for (const mem of hub.sparks.sparkMemories()) {
        const hooks = memoryHooks(mem);
        hooks.mem.paused = true;
        hooks.flushTree();
      }
    });
    onShutdown("queue", () => {
      for (const mem of hub.sparks.sparkMemories()) memoryHooks(mem).saveView();
    });
    await runShutdown("spark-close");
    const raw = readFileSync(join(rt.memory.dir, "log.jsonl"), "utf8");
    expect(raw).toContain("SPARK_MEM_FACT");
    expect(raw.endsWith("\n")).toBe(true);
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      JSON.parse(line);
    }
  } finally {
    await hub.close();
  }
});
