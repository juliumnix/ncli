import { expect, test } from "bun:test";
import { MockHarness } from "../src/harness/mock";
import { verifyCitations } from "../src/memory/recall";
import { makeHub } from "./helpers";

test("a [#id] is verified only after zoom(id, 1) in the same turn", () => {
  const events = [
    { turnId: "t1", tool: "zoom" as const, id: 3, n: 8, kind: "summary" as const, at: "2026-10-12T00:00:00.000Z" },
    { turnId: "t1", tool: "zoom" as const, id: 3, n: 1, kind: "original" as const, at: "2026-10-12T00:00:01.000Z" },
  ];
  expect(verifyCitations("the rate is 15 percent [#3]", events)).toEqual([
    { id: 3, status: "verified" },
  ]);
  expect(verifyCitations("the rate is 15 percent [#3]", events.slice(0, 1))).toEqual([
    { id: 3, status: "unverified" },
  ]);
  expect(verifyCitations("the rate is 15 percent [#3]", [])).toEqual([
    { id: 3, status: "unverified" },
  ]);
  expect(verifyCitations("no citation here", events)).toEqual([]);
});

test("a talk that cites [#id] after zoom(id,1) stores verified; a cite without the original is unverified", async () => {
  const ok = new MockHarness(() => ({
    tools: [{ name: "zoom", input: { id: 0, n: 1 } }],
    text: "The rate is 15 percent [#0].",
  }));
  const { hub } = await makeHub({ harness: ok });
  try {
    const recalls: Array<{ type: string; citations: unknown; events: Array<{ id: number; n: number; kind: string }> }> = [];
    hub.subscribe((ev) => {
      if (ev.type === "recall") recalls.push(ev);
    });
    await hub.send("what is the member rate?");
    const talk = hub.memory.log.filter((m) => m.kind === "talk").at(-1);
    expect(talk?.text).toContain("[#0]");
    expect(talk?.recall).toEqual([{ id: 0, status: "verified" }]);
    expect(talk?.hops).toBeUndefined();
    expect(recalls).toHaveLength(1);
    expect(recalls[0]?.citations).toEqual([{ id: 0, status: "verified" }]);
    expect(recalls[0]?.events).toEqual([
      { turnId: hub.live?.id, tool: "zoom", id: 0, n: 1, kind: "original", at: recalls[0]?.events[0]?.at },
    ]);
  } finally {
    hub.close();
  }

  const guess = new MockHarness(() => ({
    text: "I think the rate is 10 percent [#12].",
  }));
  const second = await makeHub({ harness: guess });
  try {
    await second.hub.send("what is the member rate?");
    const talk = second.hub.memory.log.filter((m) => m.kind === "talk").at(-1);
    expect(talk?.recall).toEqual([{ id: 12, status: "unverified" }]);
  } finally {
    second.hub.close();
  }
});
