import { expect, test } from "bun:test";
import { makeHub, waitUntil } from "./helpers";

test("view://review?pr=482 opens a review fork that waits on the user", async () => {
  const { hub } = await makeHub();
  await hub.send("abre view://review?pr=482");
  await waitUntil(() => hub.forks.list().some((f) => f.view === "review"));
  const fork = hub.forks.list().find((f) => f.view === "review")!;
  expect(fork.status).toBe("needs_user");
  expect(fork.needsUser?.kind).toBe("review");
  expect(fork.ui && typeof fork.ui === "object" && "chapters" in (fork.ui as object)).toBe(true);
  await hub.ackFork(fork.id, "LGTM, member discount only");
  await waitUntil(() => hub.memory.log.some((m) => m.kind === "merge" && m.text.includes("review #1")));
  const line = hub.memory.log.find((m) => m.kind === "merge")!;
  expect(line.text).toContain("review #1");
  expect(line.text).toContain("LGTM");
  hub.close();
});
