export const LIVE_KINDS = ["mermaid", "html", "react", "url", "ui", "3d"] as const;
export type LiveKind = (typeof LIVE_KINDS)[number];

export function isLiveKind(v: string): v is LiveKind {
  return (LIVE_KINDS as readonly string[]).includes(v);
}

export interface LiveBlock {
  kind: LiveKind;
  source: string;
}

export type LiveSeg = { type: "text"; text: string } | { type: "live"; block: LiveBlock };

export type LiveRender =
  | { ok: true; kind: LiveKind; html: string }
  | { ok: false; kind: string; source: string; error: string };

const NCLI_OPEN = /(```|~~~)ncli(?:-|[ \t]+)(mermaid|html|react|url|ui|3d)\b[ \t]*\r?\n/i;
const MERMAID_OPEN = /(```|~~~)mermaid\b[ \t]*\r?\n/i;
const BARE_KIND = /^(mermaid|html|react|url|ui|3d)[ \t]*\r?\n/;

export function parseLive(text: string): LiveSeg[] {
  const segs: LiveSeg[] = [];
  let i = 0;
  while (i < text.length) {
    const fence = nextFence(text, i);
    if (!fence) {
      if (i < text.length) segs.push({ type: "text", text: text.slice(i) });
      break;
    }
    if (fence.start > i) segs.push({ type: "text", text: text.slice(i, fence.start) });
    const block = coerceBlock(fence.kind, fence.source);
    if (block.kind === "ui" && !block.source) {
      const bare = recoverBareKind(text, fence.end);
      if (bare) {
        segs.push({ type: "live", block: bare.block });
        i = bare.end;
        continue;
      }
    }
    segs.push({ type: "live", block });
    i = fence.end;
  }
  if (!segs.length) segs.push({ type: "text", text });
  return segs;
}

export function liveBlocks(text: string): LiveBlock[] {
  return parseLive(text).flatMap((s) => (s.type === "live" ? [s.block] : []));
}

export function renderToolToFence(kind: string, source: string): string {
  const k = isLiveKind(kind) ? kind : "html";
  return `\`\`\`ncli ${k}\n${source.trim()}\n\`\`\``;
}

function coerceBlock(kind: LiveKind, source: string): LiveBlock {
  const src = source.trim();
  const nested = src.match(/^(?:```|~~~)mermaid\b[ \t]*\r?\n([\s\S]+)$/i);
  if (nested?.[1] != null) {
    return { kind: "mermaid", source: nested[1].replace(/(?:```|~~~)\s*$/i, "").trim() };
  }
  if ((kind === "ui" || kind === "html") && /^(graph|flowchart)\b/i.test(src)) {
    return { kind: "mermaid", source: src };
  }
  return { kind, source: src };
}

function firstOpen(slice: string): { index: number; tick: string; kind: LiveKind; match: string } | null {
  const ncli = NCLI_OPEN.exec(slice);
  const mermaid = MERMAID_OPEN.exec(slice);
  const ncliAt = ncli?.index ?? Number.POSITIVE_INFINITY;
  const mermaidAt = mermaid?.index ?? Number.POSITIVE_INFINITY;
  if (ncli && ncli.index != null && ncliAt <= mermaidAt) {
    const kind = (ncli[2] ?? "").toLowerCase();
    if (!isLiveKind(kind)) return null;
    return { index: ncli.index, tick: ncli[1] ?? "```", kind, match: ncli[0] };
  }
  if (mermaid && mermaid.index != null) {
    return { index: mermaid.index, tick: mermaid[1] ?? "```", kind: "mermaid", match: mermaid[0] };
  }
  return null;
}

function nextFence(text: string, from: number): { start: number; end: number; kind: LiveKind; source: string } | null {
  const slice = text.slice(from);
  const m = firstOpen(slice);
  if (!m) return null;
  const start = from + m.index;
  const tick = m.tick;
  const kind = m.kind;
  const bodyStart = start + m.match.length;
  const close = new RegExp(`(?:^|\\n)${escapeRe(tick)}[ \\t]*\\w*[ \\t]*(?:\\n|$)`);
  const rest = text.slice(bodyStart);
  const c = close.exec(rest);
  if (!c || c.index == null) {
    return { start, end: text.length, kind, source: rest };
  }
  const source = rest.slice(0, c.index);
  const end = bodyStart + c.index + c[0].length;
  return { start, end, kind, source };
}

function recoverBareKind(text: string, from: number): { end: number; block: LiveBlock } | null {
  const rest = text.slice(from);
  const named = BARE_KIND.exec(rest);
  const flow = /^(flowchart|graph)\b/i.exec(rest);
  if (!named && !flow) return null;
  const kind: LiveKind = named && isLiveKind((named[1] ?? "").toLowerCase())
    ? (named[1]!.toLowerCase() as LiveKind)
    : "mermaid";
  const bodyStart = named ? from + named[0].length : from;
  const close = /(?:^|\n)(?:```|~~~)[ \t]*(?:\n|$)/;
  const after = text.slice(bodyStart);
  const c = close.exec(after);
  const source = (c && c.index != null ? after.slice(0, c.index) : after).trim();
  const end = c && c.index != null ? bodyStart + c.index + c[0].length : text.length;
  return { end, block: coerceBlock(kind, source) };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
