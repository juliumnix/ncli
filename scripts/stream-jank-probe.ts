#!/usr/bin/env bun
import { renderMarkdown } from "../src/live/markdown";
import { chatPaintFor } from "../src/live/chat-patch";

const finished = Array.from({ length: 80 }, (_, i) =>
  renderMarkdown(`## msg ${i}\n\nuser decided FACT_${i} applies before tax. **ok** and \`code\`.` ),
);
const stream = "Claude is writing a long reply about member discount. ".repeat(40);

function fullRebuild(n: number): number {
  const start = performance.now();
  for (let i = 0; i < n; i++) {
    const live = renderMarkdown(stream + " token".repeat(i % 20), true);
    void finished.join("") + live;
  }
  return performance.now() - start;
}

function liveOnly(n: number): number {
  const start = performance.now();
  const frozen = finished.join("");
  void frozen;
  for (let i = 0; i < n; i++) {
    void renderMarkdown(stream + " token".repeat(i % 20), true);
    if (chatPaintFor("delta", true) !== "live") throw new Error("paint");
  }
  return performance.now() - start;
}

const n = 200;
const before = fullRebuild(n);
const after = liveOnly(n);
console.log(`stream-jank-probe tokens=${n} finishedMsgs=80`);
console.log(`full rebuild+reparse ${before.toFixed(1)}ms  (~${(before / n).toFixed(2)}ms/token)`);
console.log(`live-only+rAF paint  ${after.toFixed(1)}ms  (~${(after / n).toFixed(2)}ms/token)`);
console.log(`speedup ${(before / Math.max(after, 0.01)).toFixed(1)}x`);
if (after / n > 50) {
  console.error("live path still over 50ms per token in this CPU probe");
  process.exit(1);
}
