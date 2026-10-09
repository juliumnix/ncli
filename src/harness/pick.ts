import type { NcliConfig } from "../config";
import { ClaudeCliAdapter } from "../acp/claude";
import { CodexExecAdapter } from "../acp/codex";
import { CursorAcpAdapter } from "../acp/cursor";
import { AcpHarness } from "./acp";
import { MockHarness } from "./mock";
import type { Harness } from "./types";

export function pickHarness(cfg: NcliConfig): Harness {
  switch (cfg.harness) {
    case "mock":
      return new MockHarness();
    case "claude":
      return new AcpHarness(new ClaudeCliAdapter(cfg));
    case "cursor":
      return new AcpHarness(new CursorAcpAdapter(cfg));
    case "codex":
      return new AcpHarness(new CodexExecAdapter(cfg));
    case "auto":
      try {
        if (Bun.which(cfg.claudeBin)) return new AcpHarness(new ClaudeCliAdapter(cfg));
      } catch {
        return new MockHarness();
      }
      return new MockHarness();
    default: {
      const _n: never = cfg.harness;
      return _n;
    }
  }
}
