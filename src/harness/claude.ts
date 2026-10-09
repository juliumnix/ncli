import { ClaudeCliAdapter } from "../acp/claude";
import type { NcliConfig } from "../config";
import { AcpHarness } from "./acp";

export class ClaudeHarness extends AcpHarness {
  constructor(cfg: NcliConfig) {
    super(new ClaudeCliAdapter(cfg));
  }
}
