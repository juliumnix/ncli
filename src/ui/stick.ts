export interface Stick {
  follow: boolean;
}

export type ScrollOrigin = "programmatic" | "user";

export interface ChatScroll {
  follow: boolean;
  origin: ScrollOrigin;
  userUp: boolean;
  prevTop: number;
  nextTop: number;
  leftover: number;
  slop?: number;
}

export const STICK_SLOP = 64;

export function nearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  slop = STICK_SLOP,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= slop;
}

export function onChatScroll(s: ChatScroll): Stick {
  switch (s.origin) {
    case "programmatic":
      return { follow: s.follow };
    case "user":
      if (s.userUp || s.nextTop < s.prevTop) return { follow: false };
      if (s.leftover <= (s.slop ?? STICK_SLOP)) return { follow: true };
      return { follow: s.follow };
    default: {
      const _n: never = s.origin;
      return { follow: _n };
    }
  }
}

export function shouldPin(stick: Stick): boolean {
  return stick.follow;
}

export function followFrame(cur: number, target: number, k = 0.22): { next: number; done: boolean } {
  const next = cur + (target - cur) * k;
  if (Math.abs(target - next) < 0.6) return { next: target, done: true };
  return { next, done: false };
}

export function floorTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

export function composerClearance(composerHeight: number, bottomOffset = 28, gap = 16): number {
  return Math.max(composerHeight + bottomOffset + gap, 96);
}
