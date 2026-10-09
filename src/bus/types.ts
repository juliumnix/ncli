import type { SeatId } from "../types";

export type BusKind = "ask" | "reply" | "post" | "event";

export type BusOp = "wait" | "inbox" | "read" | "hook" | "mcp";

export type BusAgent = SeatId | "main";

export interface WireMsg {
  seq?: number;
  id?: string;
  from: string;
  to?: string;
  kind: BusKind;
  body: string;
  ticket?: string;
  parent?: string;
  fork?: string;
  timeout?: number;
  op?: BusOp;
}

export interface BusLine {
  seq: number;
  from: string;
  to: string;
  kind: BusKind;
  body: string;
  ticket?: string;
  parent?: string;
  fork?: string;
  at: string;
}

export interface Ticket {
  id: string;
  from: string;
  to: SeatId;
  prompt: string;
  fork?: string;
  parent?: string;
  depth: number;
  status: "pending" | "running" | "done" | "error";
  result?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  done: Promise<Ticket>;
}

export interface BusAskOpts {
  fork?: string;
  mode?: string;
  timeout?: number;
  parent?: string;
}

export interface BusRunnerReq {
  agent: SeatId;
  prompt: string;
  cwd: string;
  timeout: number;
  signal: AbortSignal;
  ticket: string;
}

export type BusRunner = (req: BusRunnerReq) => Promise<{ text: string }>;

export interface BusGuards {
  maxDepth: number;
  maxChildren: number;
  budget: number;
}

export function isSeat(id: string): id is SeatId {
  return id === "claude" || id === "codex" || id === "cursor";
}

export function inboxKey(to: string): string {
  if (to === "claude") return "main";
  return to;
}

export function displayName(id: string): string {
  switch (id) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "main":
      return "NCLI";
    default:
      return id;
  }
}

export function formatBusLine(line: BusLine): string {
  const arrow = `${displayName(line.from)} → ${displayName(line.to)}`;
  const body = line.body.replace(/\s+/g, " ").trim().slice(0, 220);
  switch (line.kind) {
    case "ask":
      return `${arrow}: ask · ${body}`;
    case "reply":
      return `${arrow}: ${body}`;
    case "post":
      return `${arrow}: ${body}`;
    case "event":
      return `${arrow}: ${body}`;
    default: {
      const _n: never = line.kind;
      return String(_n);
    }
  }
}

export function inboxBlock(lines: BusLine[]): string {
  if (!lines.length) return "";
  const rows = lines.map((l) => `${displayName(l.from)} → ${displayName(l.to)}: ${l.body}`).join("\n");
  return `<inbox>\n${rows}\n</inbox>\n\n`;
}
