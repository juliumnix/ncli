export type LiveKind = "mermaid" | "html" | "react" | "url";

export interface LiveBlock {
  kind: LiveKind;
  source: string;
}

export type LiveSeg = { type: "text"; text: string } | { type: "live"; block: LiveBlock };

const FENCE = /```ncli[ \t]+(mermaid|html|react|url)[ \t]*\n([\s\S]*?)```/g;

export function parseLive(text: string): LiveSeg[] {
  const segs: LiveSeg[] = [];
  let last = 0;
  const re = new RegExp(FENCE.source, "g");
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) segs.push({ type: "text", text: text.slice(last, idx) });
    segs.push({ type: "live", block: { kind: m[1] as LiveKind, source: m[2].trim() } });
    last = idx + m[0].length;
  }
  if (last < text.length) segs.push({ type: "text", text: text.slice(last) });
  if (!segs.length) segs.push({ type: "text", text });
  return segs;
}

export function liveBlocks(text: string): LiveBlock[] {
  return parseLive(text).flatMap((s) => (s.type === "live" ? [s.block] : []));
}

export function renderToolToFence(kind: string, source: string): string {
  const k = kind === "mermaid" || kind === "html" || kind === "react" || kind === "url" ? kind : "html";
  return `\`\`\`ncli ${k}\n${source.trim()}\n\`\`\``;
}
