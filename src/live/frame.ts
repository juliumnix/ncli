import { escapeHtml } from "../util";
import type { LiveBlock, LiveKind } from "./parse";
import { uiKey, wrapUiSource } from "./ui-frame";

const CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'";

export function frameHtml(block: LiveBlock): string {
  switch (block.kind) {
    case "mermaid":
      return doc(`<style>svg{max-width:100%}</style>${mermaidSvg(block.source)}`);
    case "html":
      return doc(block.source);
    case "react":
      return doc(jsxLite(block.source));
    case "url":
      return doc(`<p style="font:13px sans-serif;color:#555">preview</p>`);
    case "ui":
      return wrapUiSource(block.source);
    default: {
      const _n: never = block.kind;
      return String(_n);
    }
  }
}

export function iframeTag(block: LiveBlock, id?: string): string {
  if (block.kind === "url") {
    const href = safeUrl(block.source);
    if (!href) return `<div class="live mute">url bloqueada</div>`;
    return `<iframe class="live-frame" title="live url"${id ? ` data-live="${id}"` : ""} sandbox="allow-scripts allow-popups" src="${escapeHtml(href)}"></iframe>`;
  }
  const srcdoc = frameHtml(block)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;");
  const frame = `<iframe class="live-frame${block.kind === "ui" ? " live-ui" : ""}" title="live ${block.kind}"${id ? ` data-live="${id}"` : ""}${block.kind === "ui" ? ` data-ui-key="${uiKey(block.source)}"` : ""} sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe>`;
  if (block.kind === "ui") {
    return `<div class="ui-card live-wrap in" data-ui-key="${uiKey(block.source)}"><button type="button" class="ui-expand" aria-label="Expandir">⤢</button>${frame}</div>`;
  }
  return frame;
}

export function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    return null;
  } catch {
    return null;
  }
}

function doc(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body>${body}</body></html>`;
}

export function mermaidSvg(source: string): string {
  const nodes = new Map<string, string>();
  const edges: Array<[string, string]> = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || /^graph\b|^flowchart\b/i.test(line)) continue;
    const edge = line.match(/^(\w+)(?:\[([^\]]+)\])?\s*-->\s*(\w+)(?:\[([^\]]+)\])?/);
    if (edge) {
      nodes.set(edge[1], edge[2] ?? nodes.get(edge[1]) ?? edge[1]);
      nodes.set(edge[3], edge[4] ?? nodes.get(edge[3]) ?? edge[3]);
      edges.push([edge[1], edge[3]]);
      continue;
    }
    const node = line.match(/^(\w+)\[([^\]]+)\]/);
    if (node) nodes.set(node[1], node[2]);
  }
  const ids = [...nodes.keys()];
  const w = Math.max(280, ids.length * 120);
  const boxes = ids
    .map((id, i) => {
      const x = 20 + i * 120;
      const label = escapeHtml(nodes.get(id) ?? id);
      return `<rect x="${x}" y="28" width="100" height="40" rx="8" fill="#e8f1ff" stroke="#93c5fd"/><text x="${x + 50}" y="53" text-anchor="middle" font-size="11" font-family="sans-serif">${label}</text>`;
    })
    .join("");
  const arrows = edges
    .map(([a, b]) => {
      const i = ids.indexOf(a);
      const j = ids.indexOf(b);
      const x1 = 20 + i * 120 + 100;
      const x2 = 20 + j * 120;
      return `<line x1="${x1}" y1="48" x2="${x2}" y2="48" stroke="#2563eb" marker-end="url(#ncli-arrow)"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 96" width="100%" height="96"><defs><marker id="ncli-arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#2563eb"/></marker></defs>${arrows}${boxes}</svg>`;
}

export function jsxLite(source: string): string {
  let s = source.trim();
  s = s.replace(/^export default function \w+\(\)\s*\{/, "").replace(/\}\s*$/, "");
  s = s.replace(/^function \w+\(\)\s*\{/, "").replace(/\}\s*$/, "");
  s = s.replace(/^\s*return\s*\(/, "").replace(/\)\s*;?\s*$/, "");
  s = s.replace(/\bclassName=/g, "class=");
  s = s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
  s = s.replace(/\{(['"])(.*?)\1\}/g, "$2");
  return `<div class="ncli-react">${s}</div>`;
}

export type { LiveKind };
