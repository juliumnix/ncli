import { expect, test } from "bun:test";
import { toHarnessEvents } from "../src/acp/map";
import { MockHarness } from "../src/harness/mock";
import type { Hub } from "../src/hub";
import { verifyCitations } from "../src/memory/recall";
import type { Message, RecallEvent } from "../src/types";
import { makeHub } from "./helpers";

const SPACE = "proj:test";
const OTHER = "proj:other";
const AT = "2026-10-12T00:00:00.000Z";

function msg(i: number, text: string, extra: Partial<Message> = {}): Message {
  return {
    i,
    kind: "user",
    text,
    size: text.length,
    date: AT,
    ...extra,
  };
}

function zoomOriginal(id: number, space = SPACE): RecallEvent {
  return { turnId: "t1", tool: "zoom", id, n: 1, kind: "original", space, at: AT };
}

test("a [#id] is verified only after zoom(id, 1) in the same space on an existing id", () => {
  const log = [msg(0, "pad"), msg(1, "pad"), msg(2, "pad"), msg(3, "the rate is 15 percent")];
  const events = [
    { turnId: "t1", tool: "zoom" as const, id: 3, n: 8, kind: "summary" as const, space: SPACE, at: AT },
    zoomOriginal(3),
  ];
  expect(verifyCitations("the rate is 15 percent [#3]", events, log, SPACE)).toEqual([
    { id: 3, status: "verified" },
  ]);
  expect(verifyCitations("the rate is 15 percent [#3]", events.slice(0, 1), log, SPACE)).toEqual([
    { id: 3, status: "unverified" },
  ]);
  expect(verifyCitations("the rate is 15 percent [#3]", [], log, SPACE)).toEqual([
    { id: 3, status: "unverified" },
  ]);
  expect(verifyCitations("no citation here", events, log, SPACE)).toEqual([]);
  expect(verifyCitations("the rate is 15 percent [#3]", [zoomOriginal(3, OTHER)], log, SPACE)).toEqual([
    { id: 3, status: "unverified" },
  ]);
  expect(verifyCitations("ghost [#12]", [zoomOriginal(12)], [], SPACE)).toEqual([
    { id: 12, status: "unverified" },
  ]);
});

test("a citation of a superseded fact is not verified", () => {
  const log = [
    msg(0, "rate is 10"),
    msg(1, "rate is 15"),
    msg(2, "supersedes #0 → #1: user corrected the rate", {
      kind: "note",
      supersedes: [0],
      successor: 1,
      reason: "user corrected the rate",
    }),
  ];
  expect(verifyCitations("the rate is 10 [#0]", [zoomOriginal(0)], log, SPACE)).toEqual([
    { id: 0, status: "superseded" },
  ]);
  expect(verifyCitations("the rate is 15 [#1]", [zoomOriginal(1)], log, SPACE)).toEqual([
    { id: 1, status: "verified" },
  ]);
});

test("an ACP mcp__ncli__zoom title becomes zoom", async () => {
  async function* updates() {
    yield {
      sessionUpdate: "tool_call" as const,
      toolCallId: "call_zoom_1",
      title: "mcp__ncli__zoom",
      rawInput: { id: 0, n: 1 },
    };
  }
  const events = [];
  for await (const ev of toHarnessEvents(updates(), { prompt: "x" })) events.push(ev);
  expect(events).toEqual([
    { type: "tool", name: "zoom", input: { id: 0, n: 1 }, id: "call_zoom_1", seat: "claude" },
  ]);
});

test("a talk cites verified only after a successful callMcp zoom in that turn", async () => {
  const box: { hub?: Hub } = {};
  const ok = new MockHarness(() => ({ text: "The rate is 15 percent [#0]." }));
  const run = ok.run.bind(ok);
  ok.run = async function* (opts) {
    await box.hub!.callMcp("zoom", { id: 0, n: 1 }, "main");
    yield* run(opts);
  };
  const { hub } = await makeHub({ harness: ok });
  box.hub = hub;
  try {
    hub.memory.append({ kind: "user", text: "member discount is 15 percent" });
    const recalls: Array<{ type: string; citations: unknown; events: Array<{ id: number; n: number; kind: string; space: string }> }> = [];
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
      {
        turnId: hub.live?.id,
        tool: "zoom",
        id: 0,
        n: 1,
        kind: "original",
        space: hub.spaces.currentId,
        at: recalls[0]?.events[0]?.at,
      },
    ]);
  } finally {
    hub.close();
  }
});

test("a harness zoom event without callMcp does not verify, and a failed zoom does not record", async () => {
  const display = new MockHarness(() => ({
    tools: [{ name: "zoom", input: { id: 0, n: 1 } }],
    text: "The rate is 15 percent [#0].",
  }));
  const shown = await makeHub({ harness: display });
  try {
    shown.hub.memory.append({ kind: "user", text: "member discount is 15 percent" });
    await shown.hub.send("what is the member rate?");
    const talk = shown.hub.memory.log.filter((m) => m.kind === "talk").at(-1);
    expect(talk?.recall).toEqual([{ id: 0, status: "unverified" }]);
  } finally {
    shown.hub.close();
  }

  const box: { hub?: Hub } = {};
  const fail = new MockHarness(() => ({ text: "I think the rate is 10 percent [#12]." }));
  const run = fail.run.bind(fail);
  fail.run = async function* (opts) {
    const out = await box.hub!.callMcp("zoom", { id: 12, n: 1 }, "main");
    expect(out).toContain("No line");
    yield* run(opts);
  };
  const second = await makeHub({ harness: fail });
  box.hub = second.hub;
  try {
    await second.hub.send("what is the member rate?");
    const talk = second.hub.memory.log.filter((m) => m.kind === "talk").at(-1);
    expect(talk?.recall).toEqual([{ id: 12, status: "unverified" }]);
  } finally {
    second.hub.close();
  }
});
