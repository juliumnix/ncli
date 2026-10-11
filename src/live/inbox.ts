import type { Spark, SparkStatus } from "../types";

export type InboxState = "working" | "needs_you" | "ready" | "settled";

export interface InboxRow {
  id: string;
  view: string;
  seq: number;
  title: string;
  state: InboxState;
  label: string;
}

export interface InboxNotify {
  title: string;
  body: string;
  tag: string;
}

const LABEL: Record<InboxState, string> = {
  working: "trabalhando",
  needs_you: "precisa de você",
  ready: "pronto",
  settled: "fechado",
};

export function inboxState(status: SparkStatus): InboxState {
  switch (status) {
    case "running":
      return "working";
    case "needs_user":
      return "needs_you";
    case "done":
      return "ready";
    case "merged":
    case "error":
      return "settled";
    default: {
      const _n: never = status;
      return _n;
    }
  }
}

export function inboxLabel(state: InboxState): string {
  return LABEL[state];
}

export function inboxRows(sparks: Spark[]): InboxRow[] {
  return sparks
    .map((s) => ({
      id: s.id,
      view: s.view,
      seq: s.seq,
      title: s.title,
      state: inboxState(s.status),
      label: inboxLabel(inboxState(s.status)),
    }))
    .filter((r) => r.state !== "settled");
}

export function nextNeedsYou(sparks: Spark[], afterId?: string): Spark | undefined {
  const waiting = sparks.filter((s) => inboxState(s.status) === "needs_you");
  if (!waiting.length) return undefined;
  if (!afterId) return waiting[0];
  const i = waiting.findIndex((s) => s.id === afterId);
  if (i < 0) return waiting[0];
  return waiting[(i + 1) % waiting.length];
}

export function shouldNotify(opts: {
  prev?: Spark;
  next: Spark;
  hidden: boolean;
  permission: NotificationPermission | "granted" | "denied" | "default";
}): InboxNotify | null {
  if (!opts.hidden || opts.permission !== "granted") return null;
  const nextState = inboxState(opts.next.status);
  if (nextState !== "needs_you" && nextState !== "ready") return null;
  const prevState = opts.prev ? inboxState(opts.prev.status) : undefined;
  if (prevState === nextState) return null;
  return {
    title: nextState === "needs_you" ? "spark precisa de você" : "spark pronto",
    body: `${opts.next.view} #${opts.next.seq} · ${opts.next.title}`,
    tag: opts.next.id,
  };
}
