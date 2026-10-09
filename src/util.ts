export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function cutUtf8(s: string, max: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= max) return s;
  let end = max;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
  return new TextDecoder().decode(bytes.slice(0, end));
}

export function isPowerOfTwo(n: number): boolean {
  return n >= 1 && (n & (n - 1)) === 0;
}

export function flattenLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function localTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function assertNever(x: never, msg = "unexpected"): never {
  throw new Error(`${msg}: ${String(x)}`);
}

export function parseViewLink(text: string): { id: string; params: Record<string, string> }[] {
  const out: { id: string; params: Record<string, string> }[] = [];
  const re = /view:\/\/([a-z0-9_-]+)(?:\?([^\s)<"'，,]+))?/gi;
  for (const m of text.matchAll(re)) {
    const id = m[1].toLowerCase();
    const params: Record<string, string> = {};
    if (m[2]) {
      const qs = new URLSearchParams(m[2]);
      for (const [k, v] of qs) params[k] = v;
    }
    out.push({ id, params });
  }
  return out;
}

export function escapeHtml(s: string): string {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatInline(s: string): string {
  return escapeHtml(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
