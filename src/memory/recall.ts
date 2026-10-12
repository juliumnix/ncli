import type { Citation, RecallEvent, RecallKind } from "../types";

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

export function verifyCitations(talk: string, events: readonly RecallEvent[]): Citation[] {
  const opened = new Set(
    events.filter((e) => e.tool === "zoom" && e.kind === "original").map((e) => e.id),
  );
  return parseCitations(talk).map((id) => ({
    id,
    status: opened.has(id) ? "verified" : "unverified",
  }));
}

export function recallFromTool(name: string, args: Record<string, unknown>, turnId: string, at: string): RecallEvent | undefined {
  if (name === "zoom") {
    const id = Number(args.id);
    const n = Number(args.n);
    if (!Number.isInteger(id) || id < 0 || !Number.isInteger(n) || n < 1) return undefined;
    return { turnId, tool: "zoom", id, n, kind: recallKind(n), at };
  }
  if (name === "date") {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id < 0) return undefined;
    return { turnId, tool: "date", id, at };
  }
  if (name === "recall") {
    return { turnId, tool: "recall", pattern: String(args.pattern ?? ""), at };
  }
  return undefined;
}
