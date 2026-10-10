import { iframeTag } from "../src/live/frame";
import type { LiveBlock } from "../src/live/parse";
import { DEMO_UI_SOURCE } from "../src/live/ui-demo";
import type { ViewPlugin } from "../src/views/types";

const DEMOS: LiveBlock[] = [
  {
    kind: "mermaid",
    source: `graph TD
A[subtotal] --> B[member discount]
B --> C[tax]
C --> D[total]`,
  },
  {
    kind: "html",
    source: `<div style="font:14px sans-serif;padding:8px"><b>Card</b><p>Pickup scheduling · customer picks a slot</p></div>`,
  },
  {
    kind: "react",
    source: `function Card() {
  return (
    <div className="card">
      <h3>Pickups today</h3>
      <p>12 booked</p>
    </div>
  );
}`,
  },
  {
    kind: "url",
    source: "https://example.com",
  },
  {
    kind: "ui",
    source: DEMO_UI_SOURCE,
  },
];

const live: ViewPlugin = {
  id: "live",
  label: "live",
  description: "Demo das prévias ao vivo (mermaid, html, react, url, ui) em iframe sandboxed.",
  tabs: [],
  parseLink() {
    return {};
  },
  async createFork() {
    return {
      title: "prévias ao vivo",
      needsWorktree: false,
      hold: true,
      needsUser: { kind: "review", label: "5 prévias", count: 5 },
      ui: { blocks: DEMOS },
      prompt: "Modo live. As cinco prévias já estão no painel. Não feche o fork.",
    };
  },
  render(fork) {
    const blocks = ((fork.ui as { blocks?: LiveBlock[] } | undefined)?.blocks) ?? DEMOS;
    const frames = blocks
      .map(
        (b, i) =>
          `<div class="sec">${b.kind.toUpperCase()}</div>${iframeTag(b, `live-${i}`)}`,
      )
      .join("");
    return `
      <div class="mh">
        <b>live #${fork.seq}</b> cinco prévias
        <button class="x" id="closeModal" type="button">✕</button>
      </div>
      <div class="mbody">${frames}</div>
      <form class="mi" id="forkForm">
        <input name="t" placeholder="Fala com o live…" autocomplete="off" />
      </form>`;
  },
};

export default live;
