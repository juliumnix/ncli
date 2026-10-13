export const MIN_BUN = { major: 1, minor: 4, patch: 3 } as const;

export type BunSemver = { major: number; minor: number; patch: number };

export function parseBunVersion(raw: string | undefined): BunSemver | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function bunBelowMin(raw: string | undefined, min: BunSemver = MIN_BUN): boolean {
  const v = parseBunVersion(raw);
  if (!v) return false;
  if (v.major !== min.major) return v.major < min.major;
  if (v.minor !== min.minor) return v.minor < min.minor;
  return v.patch < min.patch;
}

export function formatMinBun(min: BunSemver = MIN_BUN): string {
  return `${min.major}.${min.minor}.${min.patch}`;
}

export function bunVersionWarning(
  raw: string | undefined = typeof Bun !== "undefined" ? Bun.version : undefined,
): string | undefined {
  if (!bunBelowMin(raw)) return undefined;
  return `bun ${raw} is below ${formatMinBun()}; macOS 1.3.3 can EXC_GUARD on a close of a guarded fd`;
}
