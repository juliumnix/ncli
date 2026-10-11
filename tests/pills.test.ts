import { expect, test } from "bun:test";
import { pillClass, railSparks } from "../src/live/pills";
import type { Spark } from "../src/types";

function spark(id: string, status: Spark["status"]): Spark {
  return {
    id,
    seq: 1,
    view: "review",
    title: "PR 1",
    status,
    params: {},
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

test("a new spark joins the rail immediately, merged ones drop off", () => {
  const list = [spark("a", "running"), spark("b", "needs_user"), spark("c", "done"), spark("d", "merged")];
  expect(railSparks(list).map((f) => f.id)).toEqual(["a", "b", "c"]);
});

test("a freshly created pill pops; needs_user and done pulse; idle running does not", () => {
  expect(pillClass({ fresh: true, status: "running" })).toBe("ch pop");
  expect(pillClass({ fresh: false, status: "needs_user" })).toBe("ch attn");
  expect(pillClass({ fresh: true, status: "done" })).toBe("ch pop attn");
  expect(pillClass({ fresh: false, status: "running" })).toBe("ch");
});
