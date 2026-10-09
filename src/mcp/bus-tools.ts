import { busRpc } from "../bus/client";
import { timeoutMs } from "../bus/timeout";
import type { WireMsg } from "../bus/types";

export const BUS_TOOLS = [
  {
    name: "ask",
    description:
      "Spawn a one-shot coding agent (claude, codex, or cursor) in the fork worktree. Returns a ticket immediately. Then wait(ticket).",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "claude | codex | cursor" },
        prompt: { type: "string" },
        fork: { type: "string" },
        mode: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["agent", "prompt"],
    },
  },
  {
    name: "wait",
    description: "Block until ask tickets finish. Pass one ticket or an array. No polling; the hub resolves an in-memory promise.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { description: "ticket id or array of ids" },
        tickets: { type: "array", items: { type: "string" } },
        timeout: { type: "number" },
      },
    },
  },
  {
    name: "post",
    description: "Short message to another seat, a fork id, or main (the user chat). Delivered on their next turn.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        msg: { type: "string" },
      },
      required: ["to", "msg"],
    },
  },
  {
    name: "inbox",
    description: "Drain pending posts for this session. Call at the start of a turn and before you finish.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read",
    description: "Search the ncli-bus ledger (asks, replies, posts). Keep messages short; zoom a fork for detail.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

export async function callBusTool(
  name: string,
  args: Record<string, unknown>,
  env: { sock: string; session: string; ticket?: string },
): Promise<string> {
  const from = env.session;
  const parent = env.ticket;
  switch (name) {
    case "ask": {
      const r = await busRpc(env.sock, {
        from,
        to: String(args.agent ?? ""),
        kind: "ask",
        body: String(args.prompt ?? ""),
        fork: args.fork ? String(args.fork) : undefined,
        timeout: timeoutMs(num(args.timeout), 120_000),
        parent,
      });
      return r.body;
    }
    case "wait": {
      const ids = ticketsOf(args);
      const r = await busRpc(
        env.sock,
        {
          from,
          kind: "event",
          op: "wait",
          body: JSON.stringify(ids),
          ticket: ids.join(","),
          timeout: timeoutMs(num(args.timeout), 30_000),
        },
        timeoutMs(num(args.timeout), 30_000) + 1000,
      );
      return r.body;
    }
    case "post": {
      const r = await busRpc(env.sock, {
        from,
        to: String(args.to ?? "main"),
        kind: "post",
        body: String(args.msg ?? args.body ?? ""),
      });
      return r.body;
    }
    case "inbox": {
      const r = await busRpc(env.sock, { from, kind: "event", op: "inbox", body: "" });
      return r.body;
    }
    case "read": {
      const r = await busRpc(env.sock, {
        from,
        kind: "event",
        op: "read",
        body: String(args.query ?? args.ledger ?? ""),
      });
      return r.body;
    }
    default:
      return `unknown bus tool ${name}`;
  }
}

function ticketsOf(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.tickets)) return args.tickets.map(String);
  const t = args.ticket;
  if (Array.isArray(t)) return t.map(String);
  if (typeof t === "string" && t.trim()) return t.split(",").map((s) => s.trim());
  return [];
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export type { WireMsg };
