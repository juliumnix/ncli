export type SeatId = "claude" | "codex" | "cursor";

export type MsgKind = "user" | "talk" | "tool" | "echo" | "note" | "seat" | "merge" | "bus";

export type ForkStatus = "running" | "needs_user" | "done" | "merged" | "error";

export type NeedsUserKind = "question" | "review";

export interface Message {
  i: number;
  kind: MsgKind;
  text: string;
  size: number;
  date: string;
  seat?: SeatId;
  to?: string;
  forkId?: string;
  tool?: { name: string; input?: unknown };
  hops?: string;
}

export interface TreeNode {
  l: number;
  i: number;
  text: string;
  size: number;
}

export interface ViewPart {
  l: number;
  i: number;
  start: number;
  n: number;
  text: string;
  size: number;
  built: boolean;
}

export interface NeedsUser {
  kind: NeedsUserKind;
  label: string;
  count?: number;
}

export interface Fork {
  id: string;
  seq: number;
  view: string;
  title: string;
  status: ForkStatus;
  needsUser?: NeedsUser;
  worktree?: string;
  branch?: string;
  repo?: string;
  params: Record<string, string>;
  createdAt: string;
  mergedAt?: string;
  summary?: string;
  ui?: unknown;
  hold?: boolean;
}

export interface SeatSnapshot {
  seat: SeatId;
  status: "idle" | "running" | "done" | "error";
  text: string;
  startedAt?: string;
  endedAt?: string;
}

export interface ViewInfo {
  id: string;
  label: string;
  description: string;
  tabs: string[];
  file: string;
}

export type HubEvent =
  | { type: "message"; session: string; message: Message }
  | { type: "delta"; session: string; seat?: SeatId; text: string }
  | { type: "tool"; session: string; name: string; input?: unknown }
  | { type: "fork"; fork: Fork }
  | { type: "views"; views: ViewInfo[] }
  | { type: "debug"; session: string; lines: string[]; bytes: number; budget: number; levels: string[] }
  | { type: "error"; error: string };
