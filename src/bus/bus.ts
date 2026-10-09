import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { NcliConfig } from "../config";
import { nowIso } from "../util";
import { defaultBusRunner } from "./spawn";
import {
  formatBusLine,
  inboxBlock,
  inboxKey,
  isSeat,
  type BusAskOpts,
  type BusGuards,
  type BusKind,
  type BusLine,
  type BusOp,
  type BusRunner,
  type Ticket,
  type WireMsg,
} from "./types";

export interface BusOpts {
  cfg: NcliConfig;
  runner?: BusRunner;
  cwdFor?: (fork?: string) => string;
  onLine?: (line: BusLine) => void;
  onMcp?: (name: string, args: Record<string, unknown>, from: string) => Promise<string>;
}

interface Waiter {
  resolve: (t: Ticket) => void;
}

export class Bus {
  readonly socketPath: string;
  readonly ledger: BusLine[] = [];
  readonly tickets = new Map<string, Ticket>();
  readonly inboxes = new Map<string, BusLine[]>();
  private seq = 0;
  private ticketN = 0;
  private asksByFrom = new Map<string, number>();
  private running = 0;
  private server: ReturnType<typeof Bun.listen> | undefined;
  private readonly runner: BusRunner;
  private readonly guards: BusGuards;
  private readonly cwdFor: (fork?: string) => string;
  private readonly onLine?: (line: BusLine) => void;
  private readonly onMcp?: (name: string, args: Record<string, unknown>, from: string) => Promise<string>;

  constructor(opts: BusOpts) {
    this.socketPath = join(opts.cfg.dataDir, "ncli-bus.sock");
    this.runner = opts.runner ?? defaultBusRunner(opts.cfg);
    this.cwdFor = opts.cwdFor ?? ((fork) => (fork ? opts.cfg.repo : opts.cfg.repo));
    this.onLine = opts.onLine;
    this.onMcp = opts.onMcp;
    this.guards = {
      maxDepth: opts.cfg.busDepth,
      maxChildren: opts.cfg.busChildren,
      budget: opts.cfg.busBudget,
    };
  }

  liveChildren(): number {
    return this.running;
  }

  async listen(): Promise<string> {
    if (this.server) return this.socketPath;
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    const bus = this;
    this.server = Bun.listen({
      unix: this.socketPath,
      socket: {
        data(socket, data) {
          bus.onSockData(socket, data);
        },
        error() {},
      },
    });
    return this.socketPath;
  }

  close(): void {
    this.server?.stop(true);
    this.server = undefined;
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
  }

  ask(from: string, agent: string, prompt: string, opts: BusAskOpts = {}): { ticket: string } | { error: string } {
    if (!isSeat(agent)) return { error: `agente desconhecido: ${agent}` };
    const parent = opts.parent;
    const { depth, cycle } = this.walkChain(parent, from, agent);
    if (cycle) return { error: "ciclo: o ticket volta pra um agente da cadeia" };
    if (depth + 1 > this.guards.maxDepth) {
      return { error: `profundidade ${depth + 1} > max ${this.guards.maxDepth}` };
    }
    if (this.running >= this.guards.maxChildren) {
      return { error: `muitos filhos ao mesmo tempo (${this.guards.maxChildren})` };
    }
    const billed = opts.fork ?? from;
    const used = this.asksByFrom.get(billed) ?? 0;
    if (used >= this.guards.budget) {
      return { error: `orçamento do fork ${billed} esgotado (${this.guards.budget})` };
    }
    this.asksByFrom.set(billed, used + 1);
    const id = `t${++this.ticketN}`;
    let resolve!: (t: Ticket) => void;
    const done = new Promise<Ticket>((r) => {
      resolve = r;
    });
    const ticket: Ticket = {
      id,
      from,
      to: agent,
      prompt,
      fork: opts.fork,
      parent,
      depth: depth + 1,
      status: "pending",
      startedAt: Date.now(),
      done,
    };
    (ticket as Ticket & { settle: Waiter }).settle = { resolve };
    this.tickets.set(id, ticket);
    ticket.status = "running";
    this.running++;
    this.append({
      from,
      to: agent,
      kind: "ask",
      body: prompt,
      ticket: id,
      parent,
      fork: opts.fork,
    });
    void this.runTicket(ticket, opts.timeout ?? 120_000);
    return { ticket: id };
  }

  async wait(ids: string | string[], timeout = 30_000): Promise<Ticket[]> {
    const list = (Array.isArray(ids) ? ids : [ids]).map((id) => id.trim()).filter(Boolean);
    const missing = list.filter((id) => !this.tickets.has(id));
    if (missing.length) throw new Error(`ticket desconhecido: ${missing.join(",")}`);
    const waitAll = Promise.all(list.map((id) => this.tickets.get(id)!.done));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        waitAll,
        new Promise<Ticket[]>((_, reject) => {
          timer = setTimeout(() => reject(new Error("wait timeout")), timeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  post(from: string, to: string, msg: string): BusLine {
    const line = this.append({
      from,
      to,
      kind: "post",
      body: msg.replace(/\s+/g, " ").trim().slice(0, 220),
    });
    const key = inboxKey(to);
    const box = this.inboxes.get(key) ?? [];
    box.push(line);
    this.inboxes.set(key, box);
    return line;
  }

  peekInbox(who: string): BusLine[] {
    return [...(this.inboxes.get(inboxKey(who)) ?? [])];
  }

  takeInbox(who: string): BusLine[] {
    const key = inboxKey(who);
    const box = this.inboxes.get(key) ?? [];
    this.inboxes.set(key, []);
    return box;
  }

  drainPrompt(who: string): string {
    return inboxBlock(this.takeInbox(who));
  }

  read(query: string): BusLine[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.ledger.slice(-20);
    return this.ledger.filter((l) => {
      const blob = `${l.from} ${l.to} ${l.kind} ${l.body} ${l.ticket ?? ""}`.toLowerCase();
      return blob.includes(q);
    });
  }

  async handle(msg: WireMsg): Promise<WireMsg> {
    const kind: BusKind = msg.kind;
    switch (kind) {
      case "ask": {
        const r = this.ask(msg.from, msg.to ?? "", msg.body, {
          fork: msg.fork,
          timeout: msg.timeout,
          parent: msg.parent ?? msg.ticket,
        });
        if ("error" in r) return reply(msg, r.error, false);
        return { ...reply(msg, r.ticket), ticket: r.ticket };
      }
      case "post":
        this.post(msg.from, msg.to ?? "main", msg.body);
        return reply(msg, "ok");
      case "reply":
        return reply(msg, "ignored");
      case "event":
        return this.handleOp(msg);
      default: {
        const _n: never = kind;
        return reply(msg, `kind ${_n}`);
      }
    }
  }

  private handleOp(msg: WireMsg): Promise<WireMsg> | WireMsg {
    const op: BusOp = msg.op ?? "inbox";
    switch (op) {
      case "inbox": {
        const lines = this.takeInbox(msg.from);
        return reply(msg, JSON.stringify(lines.map(publicLine)));
      }
      case "hook": {
        const lines = this.peekInbox(msg.from);
        return reply(msg, JSON.stringify(lines.map(publicLine)));
      }
      case "read": {
        const lines = this.read(msg.body);
        return reply(msg, JSON.stringify(lines.slice(-30).map(publicLine)));
      }
      case "wait": {
        const ids = parseTickets(msg);
        return this.wait(ids, msg.timeout ?? 30_000)
          .then((tickets) => reply(msg, JSON.stringify(tickets.map(publicTicket))))
          .catch((err: unknown) => reply(msg, err instanceof Error ? err.message : String(err), false));
      }
      case "mcp": {
        let name = "";
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(msg.body) as { name?: string; args?: Record<string, unknown> };
          name = String(parsed.name ?? "");
          args = parsed.args ?? {};
        } catch {
          return reply(msg, "mcp json inválido", false);
        }
        if (!this.onMcp) return reply(msg, "ncli control offline", false);
        return this.onMcp(name, args, msg.from).then((text) => reply(msg, text));
      }
      default: {
        const _n: never = op;
        return reply(msg, `op ${_n}`);
      }
    }
  }

  private walkChain(parent: string | undefined, _from: string, to: string): { depth: number; cycle: boolean } {
    let depth = 0;
    let cur = parent;
    const seen = new Set<string>();
    while (cur) {
      const t = this.tickets.get(cur);
      if (!t) break;
      depth++;
      seen.add(canon(t.from));
      seen.add(canon(t.to));
      cur = t.parent;
    }
    if (seen.has(canon(to))) return { depth, cycle: true };
    return { depth, cycle: false };
  }

  private async runTicket(ticket: Ticket, timeout: number): Promise<void> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeout > 0) {
      timer = setTimeout(() => ac.abort(), timeout);
    }
    try {
      const out = await this.runner({
        agent: ticket.to,
        prompt: ticket.prompt,
        cwd: this.cwdFor(ticket.fork),
        timeout,
        signal: ac.signal,
        ticket: ticket.id,
      });
      ticket.result = out.text;
      ticket.status = "done";
      this.append({
        from: ticket.to,
        to: ticket.from,
        kind: "reply",
        body: out.text,
        ticket: ticket.id,
        parent: ticket.parent,
        fork: ticket.fork,
      });
    } catch (err) {
      ticket.status = "error";
      ticket.error = err instanceof Error ? err.message : String(err);
      this.append({
        from: ticket.to,
        to: ticket.from,
        kind: "event",
        body: ticket.error,
        ticket: ticket.id,
        fork: ticket.fork,
      });
    } finally {
      if (timer) clearTimeout(timer);
      ticket.endedAt = Date.now();
      this.running--;
      const settle = (ticket as Ticket & { settle?: Waiter }).settle;
      settle?.resolve(ticket);
    }
  }

  private append(partial: Omit<BusLine, "seq" | "at">): BusLine {
    const line: BusLine = { ...partial, seq: ++this.seq, at: nowIso() };
    this.ledger.push(line);
    this.onLine?.(line);
    return line;
  }

  private buffers = new WeakMap<object, string>();

  private onSockData(socket: { write: (s: string) => void; end: () => void }, data: Uint8Array | string): void {
    const chunk = typeof data === "string" ? data : new TextDecoder().decode(data);
    const prev = this.buffers.get(socket) ?? "";
    const all = prev + chunk;
    const parts = all.split("\n");
    this.buffers.set(socket, parts.pop() ?? "");
    void this.drainSock(socket, parts);
  }

  private async drainSock(socket: { write: (s: string) => void; end: () => void }, lines: string[]): Promise<void> {
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let msg: WireMsg;
      try {
        msg = JSON.parse(raw) as WireMsg;
      } catch {
        socket.write(`${JSON.stringify({ kind: "reply", from: "ncli", body: "json inválido", ok: false })}\n`);
        continue;
      }
      const out = await this.handle(msg);
      socket.write(`${JSON.stringify(out)}\n`);
    }
  }
}

function reply(req: WireMsg, body: string, ok = true): WireMsg {
  return {
    id: req.id,
    seq: req.seq,
    from: "ncli",
    to: req.from,
    kind: "reply",
    body,
    ticket: req.ticket,
    ...(ok ? {} : { op: req.op }),
  };
}

function parseTickets(msg: WireMsg): string[] {
  if (msg.ticket) return msg.ticket.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(msg.body) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* body is not json */
  }
  return msg.body ? [msg.body] : [];
}

function publicLine(l: BusLine): Pick<BusLine, "seq" | "from" | "to" | "kind" | "body" | "ticket"> {
  return { seq: l.seq, from: l.from, to: l.to, kind: l.kind, body: l.body, ticket: l.ticket };
}

function publicTicket(t: Ticket): { ticket: string; status: Ticket["status"]; text: string; error?: string } {
  return { ticket: t.id, status: t.status, text: t.result ?? "", error: t.error };
}

function canon(id: string): string {
  return id === "claude" ? "main" : id;
}

export { formatBusLine };
