import type { HarnessKind, NcliConfig } from "../config";

export function configuredSeatModel(cfg: NcliConfig, harness: HarnessKind): string | undefined {
  switch (harness) {
    case "claude":
      return cfg.claudeModel || undefined;
    case "cursor":
      return cfg.cursorModel;
    case "codex":
      return cfg.codexModel;
    case "mock":
    case "auto":
      return undefined;
    default: {
      const _n: never = harness;
      return _n;
    }
  }
}
