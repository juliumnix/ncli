import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeHub, waitUntil } from "./helpers";

test("view://review?pr=482 opens a review spark that waits on the user", async () => {
  const { hub } = await makeHub();
  await hub.send("abre view://review?pr=482");
  await waitUntil(() => hub.sparks.list().some((s) => s.view === "review"));
  const spark = hub.sparks.list().find((s) => s.view === "review")!;
  expect(spark.status).toBe("needs_user");
  expect(spark.needsUser?.kind).toBe("review");
  expect(spark.ui && typeof spark.ui === "object" && "chapters" in (spark.ui as object)).toBe(true);
  await hub.ackSpark(spark.id, "LGTM, member discount only");
  await waitUntil(() => hub.memory.log.some((m) => m.kind === "merge" && m.text.includes("review #1")));
  const line = hub.memory.log.find((m) => m.kind === "merge")!;
  expect(line.text).toContain("review #1");
  expect(line.text).toContain("LGTM");
  hub.close();
});

test("restore still reads data/forks into sparks", async () => {
  const { hub, dataDir } = await makeHub();
  const dir = join(dataDir, "forks", "review-9");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      id: "review-9",
      seq: 9,
      view: "review",
      title: "PR 9",
      status: "needs_user",
      params: { pr: "9" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
  hub.sparks.restore();
  const found = hub.sparks.get("review-9");
  expect(found?.spark.seq).toBe(9);
  expect(found?.spark.view).toBe("review");
  expect(await hub.callMcp("list_forks", {}, "main")).toContain("review-9");
  hub.close();
});
