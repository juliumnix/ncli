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
const GH_PR_RE = /(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gi;
const LONE_GH_PR_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/[^\s?#]*)?(?:[?#]\S*)?$/i;

export function parseViewLink(text: string): { id: string; params: Record<string, string> }[] {
  const out: { id: string; params: Record<string, string> }[] = [];
  const push = (id: string, params: Record<string, string>) => {
    const existing = out.find((x) => sameViewLink(x, { id, params }));
    if (existing) {
      if (id === "review") {
        if (!existing.params.owner && params.owner) existing.params.owner = params.owner;
        if (!existing.params.repo && params.repo) existing.params.repo = params.repo;
      }
      return;
    }
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
    push("review", { pr: m[3], owner: m[1], repo: m[2] });
  }
  return out;
}

export function sameReviewParams(a: Record<string, string>, b: Record<string, string>): boolean {
  if ((a.pr || "") !== (b.pr || "")) return false;
  if (a.owner && b.owner && a.owner !== b.owner) return false;
  if (a.repo && b.repo && a.repo !== b.repo) return false;
  return true;
}

function sameViewLink(
  a: { id: string; params: Record<string, string> },
  b: { id: string; params: Record<string, string> },
): boolean {
  if (a.id !== b.id) return false;
  if (a.id === "review") return sameReviewParams(a.params, b.params);
  return new URLSearchParams(a.params).toString() === new URLSearchParams(b.params).toString();
}

export function reviewPasteHint(text: string): { pr: string; owner: string; repo: string } | null {
  const t = text.trim();
  if (!t) return null;
  const re = new RegExp(GH_PR_RE.source, "i");
  const m = t.match(re);
  return m ? { owner: m[1], repo: m[2], pr: m[3] } : null;
}

export function isLonePrUrl(text: string): boolean {
  return LONE_GH_PR_RE.test(text.trim());
}

export function missingPrTalk(params: Record<string, string>): string {
  const pr = params.pr || "?";
  const where = params.owner && params.repo ? ` ${params.owner}/${params.repo}` : "";
  return `Não achei o pull request #${pr}${where}. O hub segue no ar.`;
}

export function ghOpenTalk(params: Record<string, string>, err: unknown): string {
  const raw = flattenLine(err instanceof Error ? err.message : String(err));
  if (/auth login|not logged in|no oauth|http 401|authentication required|gh auth/i.test(raw)) {
    return "O gh não está logado. O hub segue no ar.";
  }
  if (
    /could not resolve to a pullrequest|could not find|not found|sem fixture|no pull requests found|unknown pull request/i.test(
      raw,
    )
  ) {
    return missingPrTalk(params);
  }
  const cause = raw.slice(0, 180) || "falha no gh";
  return `Não abri o pull request: ${cause}. O hub segue no ar.`;
}

export function escapeHtml(s: string): string {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  lt: "<",
  gt: ">",
  apos: "'",
  colon: ":",
};

export function decodeHtmlEntities(raw: string): string {
  return String(raw).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, ent: string) => {
    if (/^#x/i.test(ent)) {
      const n = Number.parseInt(ent.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    if (ent.startsWith("#")) {
      const n = Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? all;
  });
}

export function safeHref(raw: string): string | null {
  const t = decodeHtmlEntities(String(raw)).trim();
  if (!t || t.startsWith("//")) return null;
  if (t.startsWith("#") || t.startsWith("/") || t.startsWith("view://")) return t;
  try {
    const u = new URL(t);
    if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    return null;
  } catch {
    return null;
  }
}

const VIEW_URL_ATTR =
  /\b(href|src|action|formaction|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

export function sanitizeViewHtml(html: string): string {
  return String(html).replace(VIEW_URL_ATTR, (_all, attr: string, dq?: string, sq?: string, bare?: string) => {
    const raw = dq ?? sq ?? bare ?? "";
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '"';
    const href = safeHref(raw);
    return href ? `${attr}=${quote}${escapeHtml(href)}${quote}` : `${attr}=${quote}${quote}`;
  });
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
