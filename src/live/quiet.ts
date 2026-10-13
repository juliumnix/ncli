import { seatOf } from "../agent";
import type { SeatId, Turn, TurnStep } from "../types";
import { STILL_MS } from "./turn";

export interface QuietStatus {
  phrase: string;
  elapsedMs: number;
  stepCount: number;
  chips: Array<{ seat: SeatId; label: string }>;
  answer: string;
}

const SEAT_NAME: Record<SeatId, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

const SEAT_PHRASE: Record<SeatId, string> = {
  claude: "Consultando o Claude…",
  codex: "Consultando o Codex…",
  cursor: "Consultando o Cursor…",
};

const TOOL_PHRASE: Array<[RegExp, string]> = [
  [/read|glob|grep|list|cat|ls\b|file/i, "Lendo o projeto…"],
  [/\bcursor\b/i, "Consultando o Cursor…"],
  [/\bcodex\b/i, "Consultando o Codex…"],
  [/bash|shell|cmd|exec|run/i, "Rodando um comando…"],
  [/write|edit|patch|apply/i, "Editando arquivos…"],
  [/web|fetch|search|http/i, "Pesquisando…"],
];

export function quietStatus(turn: Turn, now = Date.now()): QuietStatus {
  const steps = turn.steps ?? [];
  const running = [...steps].reverse().find((s) => s.status === "running") ?? steps.at(-1);
  const answer = steps.filter((s) => s.kind === "text").map((s) => s.text).join("");
  const silent = Math.max(0, now - Date.parse(turn.lastEventAt || turn.startedAt));
  return {
    phrase: turn.status === "running" && silent >= STILL_MS ? stuckPhrase(turn.seat) : phraseOf(running),
    elapsedMs: Math.max(0, now - Date.parse(turn.startedAt || String(now))),
    stepCount: steps.length,
    chips: consultChips(turn),
    answer,
  };
}

export function consultChips(turn: Turn): Array<{ seat: SeatId; label: string }> {
  const seen = new Set<SeatId>();
  const chips: Array<{ seat: SeatId; label: string }> = [];
  for (const step of turn.steps ?? []) {
    const other = step.kind === "ask" ? seatOf(step.to || step.seat) : step.seat;
    if (!other || other === turn.seat || seen.has(other)) continue;
    seen.add(other);
    chips.push({ seat: other, label: `consultou ${SEAT_NAME[other]}` });
  }
  return chips;
}

export function workedLabel(turn: Turn): string {
  const ms = Math.max(0, Date.parse(turn.endedAt || turn.lastEventAt || turn.startedAt) - Date.parse(turn.startedAt));
  const s = Math.max(1, Math.round(ms / 1000));
  const n = (turn.steps ?? []).length;
  return `Trabalhou por ${s}s · ${n} ${n === 1 ? "passo" : "passos"}`;
}

export function formatElapsed(ms: number): string {
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function stuckPhrase(seat: SeatId): string {
  switch (seat) {
    case "claude":
      return "Sem resposta do Claude. O processo ainda não enviou tokens.";
    case "codex":
      return "Sem resposta do Codex. O processo ainda não enviou tokens.";
    case "cursor":
      return "Sem resposta do Cursor. O processo ainda não enviou tokens.";
    default: {
      const _n: never = seat;
      return _n;
    }
  }
}

function phraseOf(step: TurnStep | undefined): string {
  if (!step) return "Pensando…";
  switch (step.kind) {
    case "thinking":
      return "Pensando…";
    case "text":
      return "Escrevendo a resposta…";
    case "ask":
      return consultPhrase(step.to || step.seat);
    case "tool":
    case "result":
      return phraseFromName(step.tool?.name ?? step.title ?? "");
    default: {
      const _n: never = step.kind;
      return _n;
    }
  }
}

function consultPhrase(target: string | undefined): string {
  return SEAT_PHRASE[seatOf(target)];
}

function phraseFromName(name: string): string {
  for (const [re, phrase] of TOOL_PHRASE) {
    if (re.test(name)) return phrase;
  }
  return "Trabalhando…";
}
