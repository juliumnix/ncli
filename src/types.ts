import type { HarnessKind } from "./config";

export type SeatId = "claude" | "codex" | "cursor";

export type MsgKind = "user" | "talk" | "tool" | "echo" | "note" | "seat" | "merge" | "bus" | "think";

export type ForkStatus = "running" | "needs_user" | "done" | "merged" | "error";

export type NeedsUserKind = "question" | "review";

export type StepKind = "thinking" | "tool" | "text" | "ask" | "result";

export type StepStatus = "running" | "done" | "error";

export type TurnStatus = "running" | "done" | "error" | "stopped";

export interface Message {
  i: number;
  kind: MsgKind;
  text: string;
  size: number;
  date: string;
  seat?: SeatId;
  model?: string;
  to?: string;
  forkId?: string;
  tool?: { name: string; input?: unknown };
  hops?: string;
  stepId?: string;
  parentId?: string;
  durationMs?: number;
}

export interface TurnStep {
  id: string;
  kind: StepKind;
  seat: SeatId;
  model?: string;
  title: string;
  text: string;
  detail?: string;
  status: StepStatus;
  startedAt: string;
  endedAt?: string;
  parentId?: string;
  tool?: { name: string; input?: unknown };
  to?: string;
}

export interface Turn {
  id: string;
  session: string;
  seat: SeatId;
  model?: string;
  status: TurnStatus;
  startedAt: string;
  endedAt?: string;
  steps: TurnStep[];
  lastEventAt: string;
}

export interface MainAgent {
  harness: HarnessKind;
  model?: string;
}

export interface CompactStatus {
  running: boolean;
  lastNodes: number;
  tokensToday: number;
  budget: number;
  model: string;
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

export interface ContextRow {
  id: string;
  start: number;
  n: number;
  text: string;
  built: boolean;
  from: string;
  to: string;
  kind?: MsgKind;
  seat?: SeatId;
}

export type ContextOp =
  | { op: "add"; id: string }
  | { op: "update"; id: string }
  | { op: "merge"; from: [string, string]; into: string };

export interface ContextSnapshot {
  type: "context";
  session: "main";
  rows: ContextRow[];
  bytes: number;
  budget: number;
  pending: number;
  T: number;
  compact: CompactStatus;
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
  | { type: "hello" }
  | { type: "message"; session: string; message: Message }
  | { type: "delta"; session: string; seat?: SeatId; model?: string; text: string; turnId?: string; stepId?: string }
  | { type: "tool"; session: string; name: string; input?: unknown }
  | { type: "turn"; session: string; turn: Turn }
  | { type: "step"; session: string; turnId: string; step: TurnStep }
  | { type: "main"; main: MainAgent }
  | { type: "compact"; compact: CompactStatus }
  | { type: "fork"; fork: Fork }
  | { type: "views"; views: ViewInfo[] }
  | { type: "debug"; session: string; lines: string[]; bytes: number; budget: number; levels: string[] }
  | ContextSnapshot
  | { type: "error"; error: string };
