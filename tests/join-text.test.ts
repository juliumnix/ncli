import { expect, test } from "bun:test";
import { foldClaudeLines } from "../src/acp/claude";
import { joinText } from "../src/live/join-text";
import { LiveTurn } from "../src/live/turn";
import { renderMarkdown } from "../src/live/markdown";
import { assemble } from "../src/memory/assemble";
import { Memory } from "../src/memory/store";
import { tmpDir } from "./helpers";

function sj(obj: unknown): string {
  return JSON.stringify(obj);
}

test("joinText keeps mid-word tokens glued and separates sentences and blocks", () => {
  expect(joinText("Cau", "sa")).toBe("Causa");
  expect(joinText("a causa.", "Causa 1:")).toBe("a causa. Causa 1:");
  expect(joinText("a causa.", "## Causa")).toBe("a causa.\n\n## Causa");
  expect(joinText("feito.", "- item")).toBe("feito.\n\n- item");
  expect(joinText("ok ", "next")).toBe("ok next");
});

test("Claude stream-json text blocks across a tool stay separated", () => {
  const first = "vou ver o erro real rodando o `codex exec` direto.**";
  const second = "O `ask` não funcionou.";
  const lines = [
    sj({ type: "system", subtype: "init", model: "claude-opus-4-5" }),
    sj({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }),
    sj({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "vou ver o erro real rodando o `codex exec` direto." } } }),
    sj({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "**" } } }),
    sj({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
    sj({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: first },
          { type: "tool_use", id: "ask1", name: "ask", input: { agent: "codex", prompt: "ping" } },
        ],
      },
    }),
    sj({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ask1", content: "pong GPT-6" }] } }),
    sj({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } }),
    sj({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: second } } }),
    sj({ type: "stream_event", event: { type: "content_block_stop", index: 1 } }),
    sj({ type: "assistant", message: { content: [{ type: "text", text: second }] } }),
    sj({ type: "result", result: "done" }),
  ];
  const updates = foldClaudeLines(lines);
  let talk = "";
  const live = new LiveTurn("main", "claude");
  for (const update of updates) {
    if (update.sessionUpdate === "agent_message_chunk") {
      talk = joinText(talk, update.text);
      live.apply({ type: "text", text: update.text });
    }
    if (update.sessionUpdate === "tool_call") {
      live.apply({ type: "tool", id: update.toolCallId, name: update.title, input: update.rawInput ?? {} });
    }
  }
  expect(talk).toBe(`${first}\n\n${second}`);
  expect(talk).not.toContain("direto.**O");
  expect(live.turn.steps.find((s) => s.kind === "text")?.text).toBe(`${first}\n\n${second}`);
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
