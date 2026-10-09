import { agentLabel, seatOf, toolTitle } from "../agent";
import type { HarnessEvent } from "../harness/types";
import type { SeatId, Turn, TurnStep } from "../types";
import { nowIso } from "../util";

const STILL_MS = 5000;

export class LiveTurn {
  readonly turn: Turn;
  private seq = 0;
  private openThink?: TurnStep;
  private openText?: TurnStep;
  private openTools = new Map<string, TurnStep>();

  constructor(session: string, seat: SeatId, model?: string) {
    const started = nowIso();
    this.turn = {
      id: `${session}-${Date.now().toString(36)}`,
      session,
      seat,
      model,
      status: "running",
      startedAt: started,
      lastEventAt: started,
      steps: [],
    };
  }

  get id(): string {
    return this.turn.id;
  }

  elapsed(now = Date.now()): number {
    return Math.max(0, now - Date.parse(this.turn.startedAt));
  }

  silentFor(now = Date.now()): number {
    return Math.max(0, now - Date.parse(this.turn.lastEventAt));
  }

  stillWorking(now = Date.now()): boolean {
    return this.turn.status === "running" && this.silentFor(now) >= STILL_MS;
  }

  apply(ev: HarnessEvent): { step?: TurnStep; delta?: string } {
    this.turn.lastEventAt = nowIso();
    switch (ev.type) {
      case "model":
        this.turn.model = ev.model;
        return {};
      case "thinking":
        return this.appendThink(ev.text, ev.seat);
      case "text":
        return this.appendText(ev.text, ev.seat);
      case "tool":
        return { step: this.startTool(ev.id, ev.name, ev.input, ev.seat) };
      case "tool_result":
        return { step: this.endTool(ev.id, ev.content) };
      case "seat":
        return this.applySeat(ev);
      case "done":
        this.finish("done");
        return {};
      case "error":
        this.finish("error");
        return {};
      default: {
        const _n: never = ev;
        void _n;
        return {};
      }
    }
  }

  finish(status: "done" | "error" | "stopped"): void {
    if (this.turn.status !== "running") return;
    this.closeOpen("done");
    this.turn.status = status;
    this.turn.endedAt = nowIso();
    this.turn.lastEventAt = this.turn.endedAt;
  }

  label(): string {
    return agentLabel(this.turn.seat, this.turn.model);
  }

  private applySeat(ev: Extract<HarnessEvent, { type: "seat" }>): { step?: TurnStep; delta?: string } {
    const id = `seat-${ev.seat}`;
    if (ev.status === "start") {
      return { step: this.upsertAsk(id, ev.seat, ev.text ?? "", "running") };
    }
    if (ev.status === "delta" && ev.text) {
      const step = this.upsertAsk(id, ev.seat, ev.text, "running");
      step.text += ev.text;
      return { step, delta: ev.text };
    }
    if (ev.status === "done") {
      return { step: this.upsertAsk(id, ev.seat, ev.text ?? "", "done") };
    }
    if (ev.status === "error") {
      return { step: this.upsertAsk(id, ev.seat, ev.text ?? "erro", "error") };
    }
    return {};
  }

  private appendThink(text: string, seat?: SeatId): { step: TurnStep; delta: string } {
    const step = this.openThink ?? this.push({
      kind: "thinking",
      seat: seatOf(seat ?? this.turn.seat),
      title: "pensando",
      text: "",
      status: "running",
    });
    this.openThink = step;
    step.text += text;
    return { step, delta: text };
  }

  private appendText(text: string, seat?: SeatId): { step: TurnStep; delta: string } {
    if (this.openThink) this.closeStep(this.openThink, "done");
    this.openThink = undefined;
    const step = this.openText ?? this.push({
      kind: "text",
      seat: seatOf(seat ?? this.turn.seat),
      title: this.label(),
      text: "",
      status: "running",
    });
    this.openText = step;
    step.text += text;
    return { step, delta: text };
  }

  private startTool(id: string, name: string, input: unknown, seat?: SeatId): TurnStep {
    if (this.openThink) this.closeStep(this.openThink, "done");
    this.openThink = undefined;
    const step = this.push({
      id: id || this.nextId(),
      kind: name === "ask" ? "ask" : "tool",
      seat: seatOf(seat ?? this.turn.seat),
      title: toolTitle(name, input),
      text: "",
      status: "running",
      tool: { name, input },
      to: name === "ask" && input && typeof input === "object" ? String((input as { agent?: string }).agent ?? "") : undefined,
    });
    this.openTools.set(step.id, step);
    return step;
  }

  private endTool(id: string, content: string): TurnStep | undefined {
    const step = this.openTools.get(id) ?? this.turn.steps.find((s) => s.tool && this.openTools.has(s.id));
    if (!step) {
      return this.push({
        kind: "result",
        seat: this.turn.seat,
        title: "result",
        text: content,
        detail: content,
        status: "done",
      });
    }
    step.detail = content;
    this.closeStep(step, "done");
    this.openTools.delete(step.id);
    return step;
  }

  private upsertAsk(id: string, seat: SeatId, text: string, status: TurnStep["status"]): TurnStep {
    const existing = this.turn.steps.find((s) => s.id === id);
    if (existing) {
      if (text && status !== "running") existing.text = text;
      existing.status = status;
      if (status !== "running") this.closeStep(existing, status);
      return existing;
    }
    const step = this.push({
      id,
      kind: "ask",
      seat,
      title: `ask → ${agentLabel(seat)}`,
      text: status === "running" ? "" : text,
      status,
      to: seat,
    });
    if (status !== "running") this.closeStep(step, status);
    return step;
  }

  private push(partial: Omit<TurnStep, "id" | "startedAt" | "model" | "text"> & { id?: string; text?: string }): TurnStep {
    const step: TurnStep = {
      id: partial.id ?? this.nextId(),
      kind: partial.kind,
      seat: partial.seat,
      model: this.turn.model,
      title: partial.title,
      text: partial.text ?? "",
      detail: partial.detail,
      status: partial.status,
      startedAt: nowIso(),
      parentId: partial.parentId,
      tool: partial.tool,
      to: partial.to,
    };
    this.turn.steps.push(step);
    return step;
  }

  private closeOpen(status: TurnStep["status"]): void {
    if (this.openThink) this.closeStep(this.openThink, status);
    if (this.openText) this.closeStep(this.openText, status);
    for (const step of this.openTools.values()) this.closeStep(step, status);
    this.openThink = undefined;
    this.openText = undefined;
    this.openTools.clear();
  }

  private closeStep(step: TurnStep, status: TurnStep["status"]): void {
    step.status = status;
    step.endedAt = nowIso();
  }

  private nextId(): string {
    this.seq += 1;
    return `${this.turn.id}-${this.seq}`;
  }
}
