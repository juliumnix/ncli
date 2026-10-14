import { expect, test } from "bun:test";
import { makeHub } from "./helpers";

test("an open spark's Memory is listed, and close removes it", async () => {
  const { hub } = await makeHub();
  try {
    const rt = await hub.sparks.open("refino", { card: "mem-list" });
    rt.memory.append({ kind: "user", text: "SPARK_MEM_FACT" });
    const open = hub.sparks.sparkMemories();
    const found = open.find((mem) => mem.log.some((m) => m.text === "SPARK_MEM_FACT"));
    expect(found).toBe(rt.memory);
    await hub.sparks.close(rt.spark.id);
    expect(hub.sparks.sparkMemories().includes(rt.memory)).toBe(false);
  } finally {
    hub.close();
  }
});
