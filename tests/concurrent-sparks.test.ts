import { expect, test } from "bun:test";
import { makeHub, waitUntil } from "./helpers";

test("several sparks run in parallel with isolated worktrees and contexts, then all merge back", async () => {
  const { hub } = await makeHub();
  const [a, b, c] = await Promise.all([
    hub.sparks.open("refino", { card: "alpha" }),
    hub.sparks.open("refino", { card: "beta" }),
    hub.sparks.open("refino", { card: "gamma" }),
  ]);
  expect(new Set([a.spark.id, b.spark.id, c.spark.id]).size).toBe(3);
  expect(a.worktree?.path).not.toBe(b.worktree?.path);
  expect(b.worktree?.path).not.toBe(c.worktree?.path);
  expect(a.memory).not.toBe(b.memory);
  a.memory.append({ kind: "note", text: "SECRET_A_ONLY" });
  b.memory.append({ kind: "note", text: "SECRET_B_ONLY" });
  expect(a.memory.log.some((m) => m.text.includes("SECRET_A_ONLY"))).toBe(true);
  expect(a.memory.log.some((m) => m.text.includes("SECRET_B_ONLY"))).toBe(false);
  expect(b.memory.log.some((m) => m.text.includes("SECRET_B_ONLY"))).toBe(true);
  expect(b.memory.log.some((m) => m.text.includes("SECRET_A_ONLY"))).toBe(false);

  for (const rt of [a, b, c]) {
    await hub.sparks.act(rt.spark.id, { type: "answer", id: "pickup-16h", value: "block" });
    await hub.sparks.act(rt.spark.id, { type: "answer", id: "remarcacao", value: "2h" });
  }

  await waitUntil(() => [a, b, c].every((rt) => rt.spark.status === "merged"));
  const merges = hub.memory.log.filter((m) => m.kind === "merge");
  expect(merges.length).toBe(3);
  const tags = merges.map((m) => m.text);
  expect(tags.some((t) => t.includes("refino #1"))).toBe(true);
  expect(tags.some((t) => t.includes("refino #2"))).toBe(true);
  expect(tags.some((t) => t.includes("refino #3"))).toBe(true);
  hub.close();
});
