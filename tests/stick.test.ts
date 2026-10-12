import { expect, test } from "bun:test";
import {
  composerClearance,
  followFrame,
  floorTop,
  nearBottom,
  onChatScroll,
  shouldMarkUserUp,
  shouldPin,
  startFollow,
} from "../src/ui/stick";

test("nearBottom is true only when the leftover scroll is within the slop", () => {
  expect(nearBottom(0, 400, 400)).toBe(true);
  expect(nearBottom(0, 400, 800)).toBe(false);
  expect(nearBottom(336, 400, 800)).toBe(true);
  expect(nearBottom(300, 400, 800)).toBe(false);
});

test("scrolling up holds; returning to the floor follows again", () => {
  expect(
    onChatScroll({
      follow: true,
      origin: "user",
      userUp: true,
      prevTop: 100,
      nextTop: 40,
      leftover: 200,
    }),
  ).toEqual({ follow: false });
  expect(
    onChatScroll({
      follow: false,
      origin: "user",
      userUp: false,
      prevTop: 40,
      nextTop: 100,
      leftover: 0,
    }),
  ).toEqual({ follow: true });
  expect(shouldPin({ follow: false })).toBe(false);
  expect(shouldPin({ follow: true })).toBe(true);
});

test("composer clearance keeps a gap under the last line", () => {
  expect(composerClearance(46, 28, 16)).toBe(96);
  expect(composerClearance(80, 28, 16)).toBe(124);
});

test("the first jump frame lands at 375 of 1706 and is still far from the floor", () => {
  const first = followFrame(0, 1706);
  expect(Math.round(first.next)).toBe(375);
  expect(first.done).toBe(false);
  expect(1706 - first.next).toBeGreaterThan(64);
});

test("programmatic jump frames keep follow on until the floor", () => {
  const target = 1706;
  let top = 0;
  let follow = true;
  let frames = 0;
  while (follow && frames < 80) {
    const step = followFrame(top, target);
    follow = onChatScroll({
      follow,
      origin: "programmatic",
      userUp: false,
      prevTop: top,
      nextTop: step.next,
      leftover: target - step.next,
    }).follow;
    top = step.next;
    frames += 1;
    if (step.done) break;
  }
  expect(follow).toBe(true);
  expect(top).toBe(1706);
  expect(frames).toBeGreaterThan(1);
});

test("a real user-up scroll drops follow, even when leftover is still large", () => {
  expect(
    onChatScroll({
      follow: true,
      origin: "user",
      userUp: true,
      prevTop: 1706,
      nextTop: 1600,
      leftover: 106,
    }).follow,
  ).toBe(false);
  expect(
    onChatScroll({
      follow: true,
      origin: "user",
      userUp: false,
      prevTop: 800,
      nextTop: 640,
      leftover: 1066,
    }).follow,
  ).toBe(false);
});

test("user scroll back to the floor turns follow on again", () => {
  expect(
    onChatScroll({
      follow: false,
      origin: "user",
      userUp: false,
      prevTop: 1600,
      nextTop: 1700,
      leftover: 6,
    }).follow,
  ).toBe(true);
});

test("open at bottom snaps to the floor, not one lerp frame", () => {
  expect(floorTop(2606, 900)).toBe(1706);
  expect(floorTop(400, 800)).toBe(0);
});

test("wheel at the top does not mark user-up; a jump clears it", () => {
  expect(shouldMarkUserUp(0)).toBe(false);
  expect(shouldMarkUserUp(1)).toBe(true);
  expect(startFollow()).toEqual({ follow: true, userUp: false });
});
