export function timeoutMs(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return fallback;
  return raw < 1000 ? Math.round(raw * 1000) : Math.round(raw);
}
