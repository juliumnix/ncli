import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessKind } from "../config";
import { parseQuota } from "./quota";

export type LimitPolicy = "resume" | "snooze";

export interface SeatLimit {
  seat: HarnessKind;
  status: "ok" | "limited";
  resetAt?: string;
  reason?: string;
  policy: LimitPolicy;
}

export type SeatPresence = Partial<Record<HarnessKind, boolean>>;

export interface UsageSnapshot {
  seats: SeatLimit[];
  chain: HarnessKind[];
  next?: HarnessKind;
}

export function parseFallbackChain(raw: string | undefined, backup: HarnessKind): HarnessKind[] {
  const named = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isSeatKind);
  if (named.length) return unique(named);
  return unique([backup, "claude", "codex", "cursor"].filter(isSeatKind));
}

export function isSeatKind(value: string): value is HarnessKind {
  return value === "claude" || value === "codex" || value === "cursor" || value === "mock";
}

export interface UsageClock {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear?: (id: ReturnType<typeof setTimeout>) => void;
}

export class UsageBoard {
  private seats = new Map<HarnessKind, SeatLimit>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly file: string;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;
  onReset?: (seat: HarnessKind) => void;

  constructor(
    readonly dir: string,
    readonly chain: HarnessKind[],
    clock: UsageClock = {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "usage.json");
    this.now = clock.now ?? Date.now;
    this.schedule = clock.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = clock.clear ?? ((id) => clearTimeout(id));
    this.load();
    this.arm();
  }

  snapshot(from?: HarnessKind, have?: SeatPresence): UsageSnapshot {
    const seats = this.chain.map((seat) => this.limitOf(seat));
    for (const [seat, row] of this.seats) {
      if (!seats.some((s) => s.seat === seat)) seats.push(row);
    }
    const start = from ?? this.chain[0];
    const next = start ? this.nextOpen(start, have) : undefined;
    return { seats, chain: [...this.chain], next };
  }

  limitOf(seat: HarnessKind): SeatLimit {
    return this.seats.get(seat) ?? { seat, status: "ok", policy: "resume" };
  }

  markLimited(seat: HarnessKind, err: string): SeatLimit {
    const hit = parseQuota(err, this.now());
    const prev = this.limitOf(seat);
    const row: SeatLimit = {
      seat,
      status: "limited",
      resetAt: hit.limited ? hit.resetAt : undefined,
      reason: hit.limited ? hit.reason : err.slice(0, 180),
      policy: prev.policy,
    };
    this.seats.set(seat, row);
    this.save();
    this.arm();
    return row;
  }

  setPolicy(seat: HarnessKind, policy: LimitPolicy): SeatLimit {
    const row = { ...this.limitOf(seat), policy };
    this.seats.set(seat, row);
    this.save();
    this.arm();
    return row;
  }

  nextOpen(from: HarnessKind, have?: SeatPresence): HarnessKind | undefined {
    const order = this.orderFrom(from);
    return order.find((seat) => {
      if (seat === from) return false;
      if (this.limitOf(seat).status !== "ok") return false;
      if (seat === "mock") return true;
      if (!have) return true;
      return Boolean(have[seat]);
    });
  }

  clear(seat: HarnessKind): SeatLimit {
    const prev = this.limitOf(seat);
    const row: SeatLimit = { seat, status: "ok", policy: prev.policy };
    this.seats.set(seat, row);
    this.save();
    this.arm();
    return row;
  }

  close(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private orderFrom(from: HarnessKind): HarnessKind[] {
    const chain = this.chain.includes(from) ? this.chain : [from, ...this.chain];
    const i = chain.indexOf(from);
    if (i < 0) return chain;
    return [...chain.slice(i + 1), ...chain.slice(0, i)];
  }

  private fire(seat: HarnessKind): void {
    const row = this.limitOf(seat);
    if (row.status !== "limited") return;
    this.clear(seat);
    if (row.policy === "snooze") return;
    this.onReset?.(seat);
  }

  private arm(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    const next = [...this.seats.values()]
      .filter((s) => s.status === "limited" && s.policy === "resume" && s.resetAt)
      .map((s) => ({ seat: s.seat, at: Date.parse(s.resetAt!) }))
      .filter((s) => Number.isFinite(s.at))
      .sort((a, b) => a.at - b.at)[0];
    if (!next) return;
    const wait = Math.max(0, next.at - this.now());
    this.timer = this.schedule(() => this.fire(next.seat), wait);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { seats?: SeatLimit[] };
      for (const row of raw.seats ?? []) {
        if (!isSeatKind(row.seat)) continue;
        this.seats.set(row.seat, {
          seat: row.seat,
          status: row.status === "limited" ? "limited" : "ok",
          resetAt: row.resetAt,
          reason: row.reason,
          policy: row.policy === "snooze" ? "snooze" : "resume",
        });
      }
    } catch {
      this.seats.clear();
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify({ seats: [...this.seats.values()] }, null, 2), "utf8");
  }
}

function unique(list: HarnessKind[]): HarnessKind[] {
  return [...new Set(list)];
}
