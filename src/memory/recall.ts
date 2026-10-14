import type { Citation, Message, RecallEvent, RecallKind } from "../types";
import { mcpToolName } from "../util";
import { factsOf, supersededHeader, type Successor } from "./facts";

export type MessageAt = readonly Message[] | ((id: number) => Message | undefined);

export function recallKind(n: number): RecallKind {
  return n === 1 ? "original" : "summary";
}

export function parseCitations(talk: string): number[] {
  const ids: number[] = [];
  const re = /\[#(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(talk))) ids.push(Number(m[1]));
  return [...new Set(ids)];
}

export function verifyCitations(
  talk: string,
  events: readonly RecallEvent[],
  log: MessageAt,
  space: string,
  facts?: Map<number, Successor>,
): Citation[] {
  const opened = new Set(
    events
      .filter((e) => e.tool === "zoom" && e.kind === "original" && e.space === space)
      .map((e) => e.id),
  );
  const at = typeof log === "function" ? log : (id: number) => log[id];
  const index = facts ?? (typeof log === "function" ? new Map<number, Successor>() : factsOf(log));
  return parseCitations(talk).map((id) => {
    if (!at(id) || !opened.has(id)) return { id, status: "unverified" };
    if (supersededHeader(index, id)) return { id, status: "superseded" };
    return { id, status: "verified" };
  });
}

export function recallFromTool(
  name: string,
  args: Record<string, unknown>,
  turnId: string,
  at: string,
  space: string,
): RecallEvent | undefined {
  const tool = mcpToolName(name);
  if (tool === "zoom") {
    const id = Number(args.id);
    const n = Number(args.n);
    if (!Number.isInteger(id) || id < 0 || !Number.isInteger(n) || n < 1) return undefined;
    return { turnId, tool: "zoom", id, n, kind: recallKind(n), space, at };
  }
  if (tool === "date") {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id < 0) return undefined;
    return { turnId, tool: "date", id, space, at };
  }
  if (tool === "recall") {
    return { turnId, tool: "recall", pattern: String(args.pattern ?? ""), space, at };
  }
  return undefined;
}
