import { expect, test } from "bun:test";
import { pillClass, railForks } from "../src/live/pills";
import type { Fork } from "../src/types";

function fork(id: string, status: Fork["status"]): Fork {
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

test("a new fork joins the rail immediately, merged ones drop off", () => {
  const list = [fork("a", "running"), fork("b", "needs_user"), fork("c", "done"), fork("d", "merged")];
  expect(railForks(list).map((f) => f.id)).toEqual(["a", "b", "c"]);
});

test("a freshly created pill pops; needs_user and done pulse; idle running does not", () => {
  expect(pillClass({ fresh: true, status: "running" })).toBe("ch pop");
  expect(pillClass({ fresh: false, status: "needs_user" })).toBe("ch attn");
  expect(pillClass({ fresh: true, status: "done" })).toBe("ch pop attn");
  expect(pillClass({ fresh: false, status: "running" })).toBe("ch");
});
