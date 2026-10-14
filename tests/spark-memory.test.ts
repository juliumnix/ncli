import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { spaceFor } from "../src/memory/spaces";
import { makeHub } from "./helpers";

test("a spark recall and zoom miss a chat fact, and the chat misses the spark fact", async () => {
  const { hub, repo } = await makeHub();
  try {
    hub.memory.append({ kind: "user", text: "CHAT_ONLY_FACT" });
    const chatAt = hub.memory.log.findIndex((m) => m.text.includes("CHAT_ONLY_FACT"));
    const rt = await hub.sparks.open("refino", { card: "mem" });
    expect(rt.worktree?.path).toBeTruthy();
    expect(spaceFor(rt.worktree!.path)).toBe(spaceFor(repo));
    rt.memory.append({ kind: "user", text: "SPARK_ONLY_FACT" });
    const sparkAt = rt.memory.log.findIndex((m) => m.text.includes("SPARK_ONLY_FACT"));

    const sparkRecall = await hub.callMcp("recall", { pattern: "CHAT_ONLY_FACT" }, rt.spark.id);
    expect(sparkRecall).not.toContain("CHAT_ONLY_FACT");
    const sparkZoom = await hub.callMcp("zoom", { id: chatAt, n: 1 }, rt.spark.id);
    expect(sparkZoom).not.toContain("CHAT_ONLY_FACT");
    const viaWorktree = await hub.callMcp(
      "recall",
      { pattern: "CHAT_ONLY_FACT", space: spaceFor(rt.worktree!.path) },
      rt.spark.id,
    );
    expect(viaWorktree).not.toContain("CHAT_ONLY_FACT");

    const chatRecall = await hub.callMcp("recall", { pattern: "SPARK_ONLY_FACT" }, "main");
    expect(chatRecall).not.toContain("SPARK_ONLY_FACT");
    const chatZoom = await hub.callMcp("zoom", { id: sparkAt, n: 1 }, "main");
    expect(chatZoom).not.toContain("SPARK_ONLY_FACT");
    const viaSparkSpace = await hub.callMcp(
      "recall",
      { pattern: "SPARK_ONLY_FACT", space: `spark:${rt.spark.id}` },
      "main",
    );
    expect(viaSparkSpace).not.toContain("SPARK_ONLY_FACT");
  } finally {
    hub.close();
  }
});

test("close and reopen keeps spark:<id> and the spark still recalls its own fact", async () => {
  const { hub } = await makeHub();
  try {
    const rt = await hub.sparks.open("refino", { card: "keep" });
    const id = rt.spark.id;
    const space = `spark:${id}`;
    rt.memory.append({ kind: "user", text: "SPARK_KEPT_FACT" });
    await hub.sparks.close(id);
    expect(rt.spark.status).toBe("merged");
    const again = await hub.sparks.open("refino", { card: "keep" });
    expect(again.spark.id).toBe(id);
    expect(`spark:${again.spark.id}`).toBe(space);
    expect(again).toBe(rt);
    expect(existsSync(again.worktree?.path ?? "")).toBe(true);
    const recalled = await hub.callMcp("recall", { pattern: "SPARK_KEPT_FACT" }, again.spark.id);
    expect(recalled).toContain("SPARK_KEPT_FACT");
    const zoom = await hub.callMcp(
      "zoom",
      { id: again.memory.log.findIndex((m) => m.text.includes("SPARK_KEPT_FACT")), n: 1 },
      again.spark.id,
    );
    expect(zoom).toContain("SPARK_KEPT_FACT");
    const chat = await hub.callMcp("recall", { pattern: "SPARK_KEPT_FACT" }, "main");
    expect(chat).not.toContain("SPARK_KEPT_FACT");
  } finally {
    hub.close();
  }
});
