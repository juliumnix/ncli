import type { LiveKind } from "./parse";

export type LiveShape = "diagram" | "chart" | "card" | "page";

export function liveShape(kind: LiveKind, source = ""): LiveShape {
  if (kind === "mermaid") return "diagram";
  if (kind === "url") return "page";
  if (kind === "react") return "card";
  if (/chart|canvas|svg|bar|plot/i.test(source)) return "chart";
  return "card";
}

export function liveLabel(kind: LiveKind, source = ""): string {
  switch (liveShape(kind, source)) {
    case "diagram":
      return "desenhando diagrama…";
    case "chart":
      return "desenhando gráfico…";
    case "card":
      return kind === "react" ? "montando componente…" : "montando prévia…";
    case "page":
      return "carregando página…";
    default: {
      const _n: never = liveShape(kind, source);
      return _n;
    }
  }
}

export function shimmerHtml(kind: LiveKind, source = ""): string {
  const shape = liveShape(kind, source);
  const label = liveLabel(kind, source);
  return `<div class="live-ph" data-kind="${kind}" data-shape="${shape}" aria-busy="true">
    <div class="live-ph-label">${label}</div>
    <div class="live-ph-body ${shape}">${shapeMarkup(shape)}</div>
  </div>`;
}

export function liveErrorHtml(kind: LiveKind, source: string, error: string): string {
  return `<div class="live-err" data-kind="${kind}">
    <div class="live-err-h">não deu para renderizar ${kind}</div>
    <div class="live-err-m">${escape(error)}</div>
    <pre class="live-err-src">${escape(source)}</pre>
  </div>`;
}

function shapeMarkup(shape: LiveShape): string {
  switch (shape) {
    case "diagram":
      return `<i></i><i></i><i></i>`;
    case "chart":
      return `<b></b><b></b><b></b><b></b>`;
    case "card":
      return `<s></s><em></em><em></em>`;
    case "page":
      return `<s></s><em></em><em></em><em></em>`;
    default: {
      const _n: never = shape;
      return _n;
    }
  }
}

function escape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
