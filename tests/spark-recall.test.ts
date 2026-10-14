import { expect, test } from "bun:test";
import { MockHarness } from "../src/harness/mock";
import type { Hub } from "../src/hub";
import type { HubEvent, RecallEvent } from "../src/types";
import { makeHub, waitUntil } from "./helpers";

test("spark zoom mid chat turn cites only its space, and chat cites only its own", async () => {
  const box: { hub?: Hub } = {};
  const harness = new MockHarness((_prompt, session) =>
    session && session !== "main" ? { text: "spark cites [#0]" } : { text: "chat cites [#0]" },
  );
  const run = harness.run.bind(harness);
  harness.run = async function* (opts) {
    if (opts.session === "main") {
      await box.hub!.callMcp("zoom", { id: 0, n: 1 }, "main");
      const rt = await box.hub!.sparks.open("refino", { card: "iso" });
      await waitUntil(
        () => Boolean(rt.memory.log.find((m) => m.kind === "talk" && m.recall)),
        8000,
        "spark talk with recall",
      );
      yield* run(opts);
      return;
    }
    await box.hub!.callMcp("zoom", { id: 0, n: 1 }, opts.session);
    yield* run(opts);
  };
  const { hub } = await makeHub({ harness });
  box.hub = hub;
  const recalls: Extract<HubEvent, { type: "recall" }>[] = [];
  hub.subscribe((ev) => {
    if (ev.type === "recall") recalls.push(ev);
  });
  try {
    hub.memory.append({ kind: "user", text: "CHAT_ONLY_FACT" });
    const chatAt = hub.memory.log.findIndex((m) => m.text.includes("CHAT_ONLY_FACT"));
    expect(chatAt).toBeGreaterThanOrEqual(0);
    await hub.send("cite the chat fact");
    const sparkRt = [...hub.sparks.runtimes.values()].find((r) => r.spark.view === "refino");
    expect(sparkRt).toBeTruthy();
    const chatTalk = hub.memory.log.filter((m) => m.kind === "talk").at(-1);
    const sparkTalk = sparkRt!.memory.log.find((m) => m.kind === "talk");
    expect(chatTalk?.text).toContain("chat cites [#0]");
    expect(chatTalk?.recall).toEqual([{ id: 0, status: "verified" }]);
    expect(sparkTalk?.text).toContain("spark cites [#0]");
    expect(sparkTalk?.recall).toEqual([{ id: 0, status: "verified" }]);
    const chatSpace = hub.spaces.currentId;
    const sparkSpace = `spark:${sparkRt!.spark.id}`;
    const chatEv = recalls.find((r) => r.session === "main");
    const sparkEv = recalls.find((r) => r.session === sparkRt!.spark.id);
    expect(chatEv?.turnId).toBe(hub.live?.id);
    expect(sparkEv?.turnId).toBeTruthy();
    expect(sparkEv?.turnId).not.toBe(chatEv?.turnId);
    expect(idsOf(chatEv?.events ?? [])).toEqual([0]);
    expect(idsOf(sparkEv?.events ?? [])).toEqual([0]);
    expect((chatEv?.events ?? []).every((e) => e.space === chatSpace && e.turnId === chatEv?.turnId)).toBe(true);
    expect((sparkEv?.events ?? []).every((e) => e.space === sparkSpace && e.turnId === sparkEv?.turnId)).toBe(true);
    expect((chatEv?.events ?? []).some((e) => e.space === sparkSpace)).toBe(false);
    expect((sparkEv?.events ?? []).some((e) => e.space === chatSpace)).toBe(false);
  } finally {
    hub.close();
  }
}, 15000);

function idsOf(events: RecallEvent[]): number[] {
  return events.filter((e) => e.tool === "zoom").map((e) => e.id);
}
