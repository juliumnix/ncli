import { expect, test } from "bun:test";
import { LiveTurn } from "../src/live/turn";
import { parseClaudeLine } from "../src/acp/claude";
import { displayModel, agentLabel, toolTitle } from "../src/agent";

test("agent labels show name and model", () => {
  expect(displayModel("claude-opus-4-5-20251101")).toBe("Opus 4.5");
  expect(agentLabel("claude", "claude-opus-4-5")).toBe("Claude · Opus 4.5");
  expect(toolTitle("Read", { path: "src/hub.ts" })).toBe("Read src/hub.ts");
  expect(toolTitle("Bash", { command: "ls -la" })).toBe("Bash `ls -la`");
  expect(toolTitle("ask", { agent: "codex" })).toBe("ask → codex");
});

test("LiveTurn builds a timeline of thinking, tools, text and nested asks", () => {
  const live = new LiveTurn("main", "claude", "claude-opus-4-5");
  live.apply({ type: "model", model: "claude-opus-4-5" });
  live.apply({ type: "thinking", text: "vou ler o arquivo" });
  live.apply({ type: "tool", name: "Read", input: { path: "src/hub.ts" }, id: "t1" });
  live.apply({ type: "tool_result", id: "t1", content: "ok" });
  live.apply({ type: "seat", seat: "codex", status: "start" });
  live.apply({ type: "seat", seat: "codex", status: "delta", text: "bate." });
  live.apply({ type: "seat", seat: "codex", status: "done", text: "bate." });
  live.apply({ type: "text", text: "Pronto." });
  live.finish("done");
  expect(live.turn.model).toBe("claude-opus-4-5");
  expect(live.turn.status).toBe("done");
  expect(live.turn.steps.map((s) => s.kind)).toEqual(["thinking", "tool", "ask", "text"]);
  expect(live.turn.steps[1]?.title).toBe("Read src/hub.ts");
  expect(live.turn.steps[1]?.status).toBe("done");
  expect(live.turn.steps[1]?.detail).toBe("ok");
  expect(live.turn.steps[2]?.title).toContain("Codex");
  expect(live.turn.steps[3]?.text).toBe("Pronto.");
});

test("stillWorking is true after 5s of silence", () => {
  const live = new LiveTurn("main", "claude");
  live.turn.lastEventAt = new Date(Date.now() - 6000).toISOString();
  expect(live.stillWorking()).toBe(true);
  live.apply({ type: "thinking", text: "ainda" });
  expect(live.stillWorking()).toBe(false);
});

test("parseClaudeLine maps init, thinking, text deltas and tool_use", () => {
  expect(parseClaudeLine(JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-5" }))).toEqual([
    { sessionUpdate: "model", model: "claude-opus-4-5" },
  ]);
  expect(
    parseClaudeLine(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Oi" } },
    })),
  ).toEqual([{ sessionUpdate: "agent_message_chunk", text: "Oi" }]);
  expect(
    parseClaudeLine(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
    })),
  ).toEqual([{ sessionUpdate: "agent_thought_chunk", text: "hmm" }]);
  expect(
    parseClaudeLine(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "plano" }, { type: "text", text: "ok" }] },
    })),
  ).toEqual([
    { sessionUpdate: "agent_thought_chunk", text: "plano" },
    { sessionUpdate: "agent_message_chunk", text: "ok" },
  ]);
});
