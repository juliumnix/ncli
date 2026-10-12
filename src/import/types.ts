import type { SeatId } from "../types";

export type ImportSource = "claude" | "codex" | "cursor";

export interface ImportLine {
  source: ImportSource;
  session: string;
  at: string;
  kind: "user" | "talk";
  text: string;
  seat?: SeatId;
  cwd?: string;
  fingerprint: string;
}

export interface ImportPreview {
  source: ImportSource;
  root: string;
  sessions: number;
  lines: ImportLine[];
  newCount: number;
  seenCount: number;
  skipped: number;
  since?: string;
}

export interface ImportApply {
  preview: ImportPreview;
  applied: number;
}

export interface ImportArgv {
  source: ImportSource;
  since?: string;
  apply: boolean;
  verbose: boolean;
}

export interface ImportRoots {
  claude: string;
  codex: string;
  cursor: string;
}
