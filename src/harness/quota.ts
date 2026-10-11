export function isQuotaError(text: string): boolean {
  return /rate[\s_-]?limit|\bquota\b|too many requests|\b429\b|usage limit|out of extra usage|credit(?:s)? (?:exhausted|exceeded)|overloaded/i.test(
    text,
  );
}

export interface QuotaHit {
  limited: true;
  resetAt?: string;
  reason: string;
}

export function parseQuota(text: string, now = Date.now()): QuotaHit | { limited: false } {
  if (!isQuotaError(text)) return { limited: false };
  const at = parseResetAt(text, now);
  return {
    limited: true,
    resetAt: at !== undefined ? new Date(at).toISOString() : undefined,
    reason: text.replace(/\s+/g, " ").trim().slice(0, 180),
  };
}

export function parseResetAt(text: string, now = Date.now()): number | undefined {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (iso) {
    const t = Date.parse(iso[0]);
    return Number.isFinite(t) ? t : undefined;
  }
  const ms = text.match(/\bin\s+(\d+)\s*ms\b/i);
  if (ms) return now + Number(ms[1]);
  const min = text.match(/(?:in|within|em)\s+(\d+)\s*(minutes?|mins?|minutos?)\b/i);
  if (min) return now + Number(min[1]) * 60_000;
  const hr = text.match(/(?:in|within|em)\s+(\d+)\s*(hours?|hrs?|h|horas?)\b/i);
  if (hr) return now + Number(hr[1]) * 3_600_000;
  const clock = text.match(/(?:reset(?:s)?|try again|volta)\s+(?:at|às|as)\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!clock) return undefined;
  let h = Number(clock[1]);
  const m = Number(clock[2]);
  const ap = clock[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
