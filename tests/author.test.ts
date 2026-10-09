import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentLabel } from "../src/agent";
import { makeHub, tmpDir } from "./helpers";

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
  const home = tmpDir("codex-home");
  writeFileSync(join(home, "config.toml"), 'model = "gpt-6.1-sol"\n', "utf8");
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const { hub } = await makeHub();
  try {
    hub.switchMain("codex");
    expect(hub.snapshot().main.harness).toBe("codex");
    expect(hub.snapshot().main.model).toBe("gpt-6.1-sol");
    hub.switchMain("cursor");
    expect(hub.snapshot().main.model).toBe("composer-2.5");
    expect(agentLabel("codex", "gpt-6.1-sol")).toBe("Codex · GPT 6.1-sol");
    expect(agentLabel("claude", "claude-opus-4-5")).toBe("Claude · Opus 4.5");
  } finally {
    hub.close();
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});
