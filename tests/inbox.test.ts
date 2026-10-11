import { expect, test } from "bun:test";
import {
  inboxRows,
  inboxState,
  nextNeedsYou,
  shouldNotify,
} from "../src/live/inbox";
import type { Spark, SparkStatus } from "../src/types";

function spark(id: string, status: SparkStatus, extra: Partial<Spark> = {}): Spark {
  return {
    id,
    seq: extra.seq ?? 1,
    view: extra.view ?? "review",
    title: extra.title ?? "PR 1",
    status,
    params: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

test("inboxState maps spark status to working / needs_you / ready / settled", () => {
  expect(inboxState("running")).toBe("working");
  expect(inboxState("needs_user")).toBe("needs_you");
  expect(inboxState("done")).toBe("ready");
  expect(inboxState("merged")).toBe("settled");
  expect(inboxState("error")).toBe("settled");
});

test("inbox glance lists working, needs you, and ready — settled drops off", () => {
  const rows = inboxRows([
    spark("a", "running"),
    spark("b", "needs_user", { needsUser: { kind: "review", label: "pronta pra revisar" } }),
    spark("c", "done"),
    spark("d", "merged"),
    spark("e", "error"),
  ]);
  expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  expect(rows.map((r) => r.state)).toEqual(["working", "needs_you", "ready"]);
  expect(rows.map((r) => r.label)).toEqual(["trabalhando", "precisa de você", "pronto"]);
});

test("nextNeedsYou opens the first that needs you, then the next, and wraps", () => {
  const list = [
    spark("a", "running"),
    spark("b", "needs_user", { view: "review", seq: 2 }),
    spark("c", "done"),
    spark("d", "needs_user", { view: "refino", seq: 1 }),
  ];
  expect(nextNeedsYou(list)?.id).toBe("b");
  expect(nextNeedsYou(list, "b")?.id).toBe("d");
  expect(nextNeedsYou(list, "d")?.id).toBe("b");
  expect(nextNeedsYou([spark("a", "running"), spark("c", "done")])).toBeUndefined();
});

test("shouldNotify only when the tab is hidden and the spark starts needing you or is ready", () => {
  const prev = spark("a", "running");
  const needs = spark("a", "needs_user", { view: "review", seq: 4, title: "PR 482" });
  const ready = spark("a", "done", { view: "refino", seq: 2, title: "Pickup" });
  const settled = spark("a", "merged");
  expect(shouldNotify({ prev, next: needs, hidden: false, permission: "granted" })).toBeNull();
  expect(shouldNotify({ prev, next: needs, hidden: true, permission: "denied" })).toBeNull();
  expect(shouldNotify({ prev, next: needs, hidden: true, permission: "default" })).toBeNull();
  expect(shouldNotify({ prev, next: needs, hidden: true, permission: "granted" })).toEqual({
    title: "spark precisa de você",
    body: "review #4 · PR 482",
    tag: "a",
  });
  expect(shouldNotify({ prev, next: ready, hidden: true, permission: "granted" })).toEqual({
    title: "spark pronto",
    body: "refino #2 · Pickup",
    tag: "a",
  });
  expect(shouldNotify({ prev: needs, next: needs, hidden: true, permission: "granted" })).toBeNull();
  expect(shouldNotify({ prev: ready, next: settled, hidden: true, permission: "granted" })).toBeNull();
});
