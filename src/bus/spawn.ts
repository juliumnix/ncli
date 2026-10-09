import { ClaudeHarness } from "../harness/claude";
import { AcpHarness } from "../harness/acp";
import { CodexExecAdapter } from "../acp/codex";
import { CursorAcpAdapter } from "../acp/cursor";
import type { NcliConfig } from "../config";
import type { SeatId } from "../types";
import { prepareSpawn } from "../mcp/inject";
import type { BusRunner, BusRunnerReq } from "./types";

export function mockBusRunner(): BusRunner {
  return async (req) => ({ text: `[${req.agent}] ${req.prompt.replace(/\s+/g, " ").trim().slice(0, 240)}` });
}

export function defaultBusRunner(cfg: NcliConfig): BusRunner {
  if (cfg.harness === "mock") return mockBusRunner();
  return async (req: BusRunnerReq) => {
    const harness = harnessFor(cfg, req.agent);
    const inj = prepareSpawn({
      cfg,
      session: `bus-${req.ticket}`,
      harness: req.agent,
      worktree: req.cwd,
      ticket: req.ticket,
    });
    let text = "";
    for await (const ev of harness.run({
      prompt: req.prompt,
      cwd: req.cwd,
      session: `bus-${req.ticket}`,
      signal: req.signal,
      mcpConfigPath: inj.mcpConfigPath,
      mcpServers: inj.mcpServers,
      addDir: req.agent === "claude" ? inj.addDir : undefined,
      extraArgs: req.agent === "codex" ? inj.extraArgs : undefined,
    })) {
      if (ev.type === "text") text += ev.text;
      if (ev.type === "done" && ev.text) text = ev.text;
      if (ev.type === "error") throw new Error(ev.error);
    }
    return { text: text.trim() };
  };
}

function harnessFor(cfg: NcliConfig, agent: SeatId): ClaudeHarness | AcpHarness {
  switch (agent) {
    case "claude":
      return new ClaudeHarness(cfg);
    case "codex":
      return new AcpHarness(new CodexExecAdapter(cfg));
    case "cursor":
      return new AcpHarness(new CursorAcpAdapter(cfg));
    default: {
      const _n: never = agent;
      throw new Error(String(_n));
    }
  }
}
