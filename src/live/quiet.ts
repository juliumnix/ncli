import { seatOf } from "../agent";
import type { SeatId, Turn, TurnStep } from "../types";

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
  return {
    phrase: phraseOf(running),
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

function phraseOf(step: TurnStep | undefined): string {
  if (!step) return "Trabalhando…";
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
