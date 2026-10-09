import type { SeatId } from "../types";

export interface RunOpts {
  prompt: string;
  system?: string;
  cwd?: string;
  mcpConfigPath?: string;
  mcpServers?: Array<{
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    type?: string;
    url?: string;
    headers?: Record<string, string>;
  }>;
  addDir?: string[];
  model?: string;
  session?: string;
  resume?: boolean;
  signal?: AbortSignal;
  extraArgs?: string[];
}

export type HarnessEvent =
  | { type: "text"; text: string; seat?: SeatId }
  | { type: "thinking"; text: string; seat?: SeatId }
  | { type: "model"; model: string; seat?: SeatId }
  | { type: "tool"; name: string; input: unknown; id: string; seat?: SeatId }
  | { type: "tool_result"; id: string; content: string }
  | { type: "seat"; seat: SeatId; status: "start" | "delta" | "done" | "error"; text?: string }
  | { type: "done"; text: string }
  | { type: "error"; error: string };

export interface Harness {
  id: string;
  run(opts: RunOpts): AsyncIterable<HarnessEvent>;
}

export interface SeatLaunch {
  seat: SeatId;
  model?: string;
  prompt: string;
  cwd?: string;
  write?: boolean;
  outPath: string;
}
