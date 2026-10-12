import type { HarnessKind } from "./config";
import type { QueueItem } from "./queue/turn-queue";
import type { UsageSnapshot } from "./harness/usage";
import type { ImportPreview } from "./import/types";
import type { SparkResult } from "./views/manifest";

export type SeatId = "claude" | "codex" | "cursor";

export type MsgKind = "user" | "talk" | "tool" | "echo" | "note" | "seat" | "merge" | "bus" | "think";

export type SparkStatus = "running" | "needs_user" | "done" | "merged" | "error";

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
  sparkId?: string;
  tool?: { name: string; input?: unknown };
  hops?: string;
  stepId?: string;
  parentId?: string;
  durationMs?: number;
  supersedes?: number[];
  successor?: number;
  reason?: string;
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

export type ContextAuthor =
  | { kind: "user"; name: string }
  | { kind: "agent"; seat: SeatId; name: "Claude" | "Codex" | "Cursor" }
  | { kind: "mix" };

export interface ContextRow {
  id: string;
  start: number;
  n: number;
  text: string;
  summary: string;
  built: boolean;
  from: string;
  to: string;
  kind?: MsgKind;
  seat?: SeatId;
  author: ContextAuthor;
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
  userName: string;
  space?: string;
}

export interface NeedsUser {
  kind: NeedsUserKind;
  label: string;
  count?: number;
}

export interface Spark {
  id: string;
  seq: number;
  view: string;
  title: string;
  status: SparkStatus;
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
  flowStep?: string;
  result?: SparkResult;
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
  | { type: "hello"; userName: string }
  | { type: "message"; session: string; message: Message }
  | { type: "delta"; session: string; seat?: SeatId; model?: string; text: string; turnId?: string; stepId?: string }
  | { type: "tool"; session: string; name: string; input?: unknown }
  | { type: "turn"; session: string; turn: Turn }
  | { type: "step"; session: string; turnId: string; step: TurnStep }
  | { type: "main"; main: MainAgent }
  | { type: "compact"; compact: CompactStatus }
  | { type: "spark"; spark: Spark }
  | { type: "queue"; items: QueueItem[] }
  | { type: "usage"; usage: UsageSnapshot }
  | { type: "import"; preview: ImportPreview }
  | { type: "views"; views: ViewInfo[] }
  | { type: "debug"; session: string; lines: string[]; bytes: number; budget: number; levels: string[] }
  | ContextSnapshot
  | { type: "error"; error: string };
