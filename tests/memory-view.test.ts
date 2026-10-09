import { expect, test } from "bun:test";
import { assemble } from "../src/memory/assemble";
import { Memory } from "../src/memory/store";
import { toolActivityLine } from "../src/memory/turn-log";
import { makeHub, tmpDir } from "./helpers";

test("a pending view line shows truncated raw text once, not a duplicated id+n prefix", () => {
  const mem = new Memory({
    dir: tmpDir("view-pending"),
    nodeBytes: 40,
    viewBytes: 4000,
    compressor: async () => new Promise(() => undefined),
  });
  mem.append({ kind: "talk", text: "MCP ncli sem conexão, ask/wait indisponíveis" });
  const line = mem.viewLines()[0] ?? "";
  expect(line).toBe("0+1|talk: MCP ncli sem conexão, ask/wait indisponíveis");
  expect(line).not.toContain("0+1|0+1|");
  expect(line).not.toContain("not summarized yet");
  mem.append({ kind: "talk", text: `tail ${"x".repeat(400)}` });
  const long = mem.viewLines()[1] ?? "";
  expect(long.startsWith("1+1|talk: tail ")).toBe(true);
  expect(long).not.toContain("not summarized yet");
  expect(long.length).toBeLessThan(260);
});

test("pump starts a batch of pending leaves together", async () => {
  let inflight = 0;
  let max = 0;
  const mem = new Memory({
    dir: tmpDir("view-batch"),
    nodeBytes: 20,
    viewBytes: 8000,
    pumpBatch: 6,
    compressor: async (input) => {
      inflight += 1;
      max = Math.max(max, inflight);
      await Bun.sleep(25);
      inflight -= 1;
      return input.source.slice(0, 18);
    },
  });
  for (let i = 0; i < 8; i++) {
    mem.append({ kind: "talk", text: `LONG_NODE_${i} ${"x".repeat(80)}` });
  }
  await mem.pump();
  expect(max).toBeGreaterThanOrEqual(6);
  expect(mem.allBuilt()).toBe(true);
});

test("a turn keeps tools on the live timeline and writes one tools: note to memory", async () => {
  const { hub } = await makeHub();
  try {
    await hub.send("confirma o desconto member");
    const kinds = hub.memory.log.map((m) => m.kind);
    expect(kinds).not.toContain("tool");
    expect(kinds).not.toContain("echo");
    expect(kinds).not.toContain("think");
    expect(kinds.filter((k) => k === "user")).toEqual(["user"]);
    expect(kinds).toContain("talk");
    const note = hub.memory.log.find((m) => m.kind === "note" && m.text.startsWith("tools:"));
    expect(note?.text).toBe("tools: zoom, date");
    expect(hub.live?.turn.steps.some((s) => s.kind === "tool")).toBe(true);
  } finally {
    hub.close();
  }
});

test("toolActivityLine collapses repeats", () => {
  expect(toolActivityLine(["Bash", "Bash", "Read"])).toBe("tools: Bash ×2, Read");
});

test("memory refuses live timeline steps", () => {
  const mem = new Memory({
    dir: tmpDir("view-refuse"),
    nodeBytes: 200,
    viewBytes: 2000,
    compressor: async (input) => input.source,
  });
  expect(() => mem.append({ kind: "tool", text: "Bash" })).toThrow("tool");
  expect(() => mem.append({ kind: "think", text: "hmm" })).toThrow("think");
  expect(() => mem.append({ kind: "echo", text: '{"type":"tool_reference"}' })).toThrow("echo");
  expect(mem.T).toBe(0);
});

test("a later status line keeps its own date and the prompt says live tools beat memory", () => {
  const mem = new Memory({
    dir: tmpDir("view-stale"),
    nodeBytes: 200,
    viewBytes: 2000,
    compressor: async (input) => input.source,
  });
  mem.append({ kind: "talk", text: "MCP ncli sem conexão, ask/wait indisponíveis", date: "2026-10-08T12:00:00.000Z" });
  mem.append({ kind: "talk", text: "MCP ncli de volta, ask/wait ok", date: "2026-10-09T18:00:00.000Z" });
  expect(mem.dateOf(0)).toBe("2026-10-08T12:00:00.000Z");
  expect(mem.dateOf(1)).toBe("2026-10-09T18:00:00.000Z");
  const ctx = assemble(mem);
  expect(ctx.system).toContain("Live state beats memory");
  expect(ctx.system).toContain("date(id)");
  expect(ctx.view).toContain("MCP ncli sem conexão");
  expect(ctx.view).toContain("MCP ncli de volta");
});
