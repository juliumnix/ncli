export interface Stick {
  follow: boolean;
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

export function applyUserScroll(stick: Stick, near: boolean): Stick {
  return { follow: near };
}

export function shouldPin(stick: Stick): boolean {
  return stick.follow;
}

export function composerClearance(composerHeight: number, bottomOffset = 28, gap = 16): number {
  return Math.max(composerHeight + bottomOffset + gap, 96);
}
