import { expect, test } from "bun:test";
import { agentLabel } from "../src/agent";
import { makeHub } from "./helpers";

test("every talk, tool, think and bus line carries the seat that wrote it", async () => {
  const { hub } = await makeHub();
  try {
    await hub.send("desconto member");
    const authored = hub.memory.log.filter((m) => m.kind !== "user");
    expect(authored.length).toBeGreaterThan(0);
    for (const m of authored) {
      expect(["claude", "codex", "cursor"]).toContain(m.seat ?? "claude");
    }
    const talk = authored.find((m) => m.kind === "talk");
    expect(talk?.seat).toBe("claude");
    expect(agentLabel(talk!.seat!, talk?.model)).toContain("Claude");
    expect(hub.snapshot().main.harness).toBe("mock");
  } finally {
    hub.close();
  }
});

test("switching the main agent updates the header snapshot and fallback posts a notice", async () => {
  const { hub } = await makeHub();
  try {
    hub.switchMain("codex");
    expect(hub.snapshot().main.harness).toBe("codex");
    expect(agentLabel("codex")).toBe("Codex");
    expect(agentLabel("claude", "claude-opus-4-5")).toBe("Claude · Opus 4.5");
  } finally {
    hub.close();
  }
});
