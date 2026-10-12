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

export function keepRecent(s: string, max: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= max) return s;
  let start = bytes.length - max;
  while (start < bytes.length && (bytes[start] & 0b1100_0000) === 0b1000_0000) start++;
  const out = new TextDecoder().decode(bytes.slice(start));
  return out || "…";
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

export function mcpToolName(title: string): string {
  if (!title.startsWith("mcp__")) return title;
  const parts = title.split("__");
  return parts[parts.length - 1] || title;
}

export function localTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function assertNever(x: never, msg = "unexpected"): never {
  throw new Error(`${msg}: ${String(x)}`);
}

const VIEW_LINK_RE = /view:\/\/([a-z0-9_-]+)(?:\?([^\s)<"'，,]+))?/gi;
const GH_PR_RE = /(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/gi;
const LONE_GH_PR_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)(?:\/[^\s?#]*)?(?:[?#]\S*)?$/i;

export function parseViewLink(text: string): { id: string; params: Record<string, string> }[] {
  const out: { id: string; params: Record<string, string> }[] = [];
  const seen = new Set<string>();
  const push = (id: string, params: Record<string, string>) => {
    const key = `${id}?${new URLSearchParams(params).toString()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, params });
  };
  for (const m of text.matchAll(VIEW_LINK_RE)) {
    const id = m[1].toLowerCase();
    const params: Record<string, string> = {};
    if (m[2]) {
      const qs = new URLSearchParams(m[2]);
      for (const [k, v] of qs) params[k] = v;
    }
    push(id, params);
  }
  for (const m of text.matchAll(GH_PR_RE)) {
    push("review", { pr: m[1] });
  }
  return out;
}

export function reviewPasteHint(text: string): { pr: string } | null {
  const t = text.trim();
  const m = t.match(LONE_GH_PR_RE);
  return m ? { pr: m[1] } : null;
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
