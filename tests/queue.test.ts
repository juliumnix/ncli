import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TurnQueue } from "../src/queue/turn-queue";
import { MockHarness } from "../src/harness/mock";
import { assemble } from "../src/memory/assemble";
import { makeHub, tmpDir, waitUntil } from "./helpers";

test("queue.json survives process restart and keeps order", () => {
  const dir = tmpDir("q-persist");
  const a = new TurnQueue(dir);
  a.enqueue({ session: "main", text: "primeiro", mode: "queue" });
  a.enqueue({ session: "main", text: "segundo", mode: "steer" });
  a.enqueue({ session: "review-1", text: "no spark", mode: "queue" });
  expect(existsSync(join(dir, "queue.json"))).toBe(true);
  const b = new TurnQueue(dir);
  expect(b.list("main").map((i) => i.text)).toEqual(["primeiro", "segundo"]);
  expect(b.takeNext("main")?.mode).toBe("steer");
  expect(b.takeNext("main")?.text).toBe("primeiro");
  expect(b.list("main")).toEqual([]);
  expect(b.list("review-1")).toHaveLength(1);
});

test("a message sent while the turn runs does not become a user line until delivered", async () => {
  const { hub } = await makeHub();
  const first = hub.send("trabalha um pouco");
  await waitUntil(() => hub.snapshot().turning);
  await hub.send("guarda isso", { mode: "queue" });
  expect(hub.memory.log.filter((m) => m.kind === "user").map((m) => m.text)).toEqual(["trabalha um pouco"]);
  expect(hub.queue.list("main").map((i) => i.text)).toEqual(["guarda isso"]);
  const view = assemble(hub.memory).view;
  expect(view).not.toContain("guarda isso");
  await first;
  await waitUntil(() => hub.memory.log.some((m) => m.kind === "user" && m.text === "guarda isso"));
  expect(hub.queue.list("main")).toEqual([]);
  expect(hub.memory.log.filter((m) => m.kind === "user").map((m) => m.text)).toEqual([
    "trabalha um pouco",
    "guarda isso",
  ]);
  hub.close();
});

test("steer on mock lands in the same turn; queue waits for the next", async () => {
  const harness = new MockHarness();
  const { hub } = await makeHub({ harness });
  const first = hub.send("começa o turno");
  await waitUntil(() => hub.snapshot().turning);
  await hub.send("corrige o rumo", { mode: "steer" });
  await first;
  const talk = hub.memory.log.filter((m) => m.kind === "talk").at(-1)?.text ?? "";
  expect(talk).toContain("corrige o rumo");
  expect(talk).toContain("ajuste: corrige o rumo");
  expect(talk).not.toContain("ajuste: ajuste:");
  expect(hub.queue.list("main")).toEqual([]);
  hub.close();
});

test("steer strips an existing ajuste/ajusta prefix so it is not doubled", async () => {
  const harness = new MockHarness();
  const { hub } = await makeHub({ harness });
  const first = hub.send("explica o desconto");
  await waitUntil(() => hub.snapshot().turning);
  await hub.send("ajusta: só member", { mode: "steer" });
  await first;
  const talk = hub.memory.log.filter((m) => m.kind === "talk").at(-1)?.text ?? "";
  expect(talk).toContain("ajuste: só member");
  expect(talk).not.toContain("ajuste: ajusta:");
  expect(talk).not.toContain("ajuste: ajuste:");
  hub.close();
});

test("a send while the turn runs queues by default, not steer", async () => {
  const { hub } = await makeHub();
  try {
    const first = hub.send("turno longo");
    await waitUntil(() => hub.snapshot().turning);
    await hub.send("depois");
    expect(hub.queue.list("main").map((i) => i.text)).toEqual(["depois"]);
    expect(hub.memory.log.filter((m) => m.kind === "user").map((m) => m.text)).toEqual(["turno longo"]);
    await first;
    await waitUntil(() => hub.memory.log.some((m) => m.kind === "user" && m.text === "depois"));
    expect(hub.queue.list("main")).toEqual([]);
  } finally {
    hub.close();
  }
});

test("editQueued rewrites the parked text", async () => {
  const dir = tmpDir("q-edit");
  const q = new TurnQueue(dir);
  const item = q.enqueue({ session: "main", text: "rascunho", mode: "queue" });
  expect(q.update(item.id, "  texto final  ")).toBe(true);
  expect(q.list("main")[0]?.text).toBe("texto final");
});

test("sendNow promotes a queued line and interrupts the running turn", async () => {
  const harness = new MockHarness();
  const orig = harness.run.bind(harness);
  harness.run = async function* (opts) {
    await Bun.sleep(400);
    yield* orig(opts);
  };
  const { hub } = await makeHub({ harness });
  try {
    const first = hub.send("turno longo");
    await waitUntil(() => hub.snapshot().turning);
    await hub.send("espera", { mode: "queue" });
    await hub.send("agora", { mode: "queue" });
    const now = hub.queue.list("main").find((i) => i.text === "agora");
    expect(now).toBeTruthy();
    expect(hub.sendNow(now!.id)).toBe(true);
    await first;
    await waitUntil(() => hub.memory.log.some((m) => m.kind === "user" && m.text === "agora"));
    const users = hub.memory.log.filter((m) => m.kind === "user").map((m) => m.text);
    expect(users[0]).toBe("turno longo");
    expect(users[1]).toBe("agora");
    expect(users).toContain("espera");
  } finally {
    hub.close();
  }
});

test("removing a queued item drops it before drain", async () => {
  const { hub } = await makeHub();
  const first = hub.send("turno longo");
  await waitUntil(() => hub.snapshot().turning);
  await hub.send("não quero", { mode: "queue" });
  const id = hub.queue.list("main")[0]?.id;
  expect(id).toBeTruthy();
  expect(hub.dropQueued(id!)).toBe(true);
  await first;
  await Bun.sleep(40);
  expect(hub.memory.log.some((m) => m.text === "não quero")).toBe(false);
  expect(hub.queue.list("main")).toEqual([]);
  hub.close();
});
