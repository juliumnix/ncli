import { expect, test } from "bun:test";
import { joinText } from "../src/live/join-text";
import { LiveTurn } from "../src/live/turn";
import { renderMarkdown } from "../src/live/markdown";
import { assemble } from "../src/memory/assemble";
import { Memory } from "../src/memory/store";
import { tmpDir } from "./helpers";

test("joinText keeps mid-word tokens glued and separates sentences and blocks", () => {
  expect(joinText("Cau", "sa")).toBe("Causa");
  expect(joinText("a causa.", "Causa 1:")).toBe("a causa. Causa 1:");
  expect(joinText("a causa.", "## Causa")).toBe("a causa.\n\n## Causa");
  expect(joinText("feito.", "- item")).toBe("feito.\n\n- item");
  expect(joinText("ok ", "next")).toBe("ok next");
});

test("LiveTurn inserts a separator when a new text block would glue", () => {
  const live = new LiveTurn("main", "claude");
  live.apply({ type: "text", text: "essa é a causa." });
  live.apply({ type: "text", text: "Causa 1: o desconto" });
  live.apply({ type: "text", text: "## Depois" });
  expect(live.turn.steps.find((s) => s.kind === "text")?.text).toBe(
    "essa é a causa. Causa 1: o desconto\n\n## Depois",
  );
});

test("headings and mixed lists render as real HTML, not raw marks", () => {
  const html = renderMarkdown("## Causa\n- um\n- dois\n\n```js\nconst x = 1\n```");
  expect(html).toContain("<h2>Causa</h2>");
  expect(html).toContain("<ul>");
  expect(html).toContain("<li>um</li>");
  expect(html).toContain("<pre");
  expect(html).not.toContain("## Causa");
  expect(html).not.toContain("- um");
});

test("system prompt asks for a short status then a concise final answer", () => {
  const mem = new Memory({
    dir: tmpDir("join-sys"),
    nodeBytes: 200,
    viewBytes: 2000,
    compressor: async (input) => input.source,
  });
  const ctx = assemble(mem);
  expect(ctx.system).toContain("short status line");
  expect(ctx.system).toContain("live timeline");
});
