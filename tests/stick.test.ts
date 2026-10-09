import { expect, test } from "bun:test";
import { applyUserScroll, composerClearance, nearBottom, shouldPin } from "../src/ui/stick";

test("nearBottom is true only when the leftover scroll is within the slop", () => {
  expect(nearBottom(0, 400, 400)).toBe(true);
  expect(nearBottom(0, 400, 800)).toBe(false);
  expect(nearBottom(336, 400, 800)).toBe(true);
  expect(nearBottom(300, 400, 800)).toBe(false);
});

test("scrolling up holds; returning to the floor follows again", () => {
  expect(applyUserScroll({ follow: true }, false)).toEqual({ follow: false });
  expect(applyUserScroll({ follow: false }, true)).toEqual({ follow: true });
  expect(shouldPin({ follow: false })).toBe(false);
  expect(shouldPin({ follow: true })).toBe(true);
});

test("composer clearance keeps a gap under the last line", () => {
  expect(composerClearance(46, 28, 16)).toBe(96);
  expect(composerClearance(80, 28, 16)).toBe(124);
});
