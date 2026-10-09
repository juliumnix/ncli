import type { Fork, SeatId } from "../src/types";
import type { ViewActionResult, ViewPlugin } from "../src/views/types";
import { escapeHtml, formatInline } from "../src/util";

export const REFINE_DONE_SCORE = 0.9;

export type RefinoRole = "Produto" | "Engenharia" | "Analista";

export interface RefinoParecer {
  role: RefinoRole;
  seat: SeatId;
  text: string;
}

export interface RefinoQuestion {
  id: string;
  text: string;
  options: string[];
  answer?: string;
}

export interface RefinoUi {
  kind: "refino";
  card: string;
  score: number;
  pareceres: RefinoParecer[];
  questions: RefinoQuestion[];
}

const SEAT_NAME: Record<SeatId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

const SEAT_ICON: Record<SeatId, string> = {
  claude: "/icons/claude.svg",
  codex: "/icons/openai.svg",
  cursor: "/icons/cursor.svg",
};

function mockUi(card: string): RefinoUi {
  return {
    kind: "refino",
    card,
    score: 0.78,
    pareceres: [
      {
        role: "Produto",
        seat: "claude",
        text: "Clear value: fewer calls to reschedule. Acceptance: the customer picks a slot, gets a confirmation, and can reschedule up to 2h before.",
      },
      {
        role: "Engenharia",
        seat: "codex",
        text: "Reuses `SlotService` from acme/shop. Missing reschedule endpoint on the store API. Medium risk: store timezone.",
      },
      {
        role: "Analista",
        seat: "cursor",
        text: "Contradiction: the card says \"any time\", but store rules block pickup after 16:00.",
      },
    ],
    questions: [
      {
        id: "pickup-16h",
        text: "Pickup after 16:00: block it, or let the store decide?",
        options: ["block", "store decides"],
      },
      {
        id: "remarcacao",
        text: "Remarcação até quanto tempo antes?",
        options: ["2h", "24h"],
      },
    ],
  };
}

function uiOf(fork: Fork): RefinoUi {
  return fork.ui as RefinoUi;
}

function unanswered(ui: RefinoUi): RefinoQuestion[] {
  return ui.questions.filter((q) => !q.answer);
}

function waiting(ui: RefinoUi) {
  const n = unanswered(ui).length;
  if (!n) return null;
  return {
    kind: "question" as const,
    label: `${n} pergunta${n === 1 ? "" : "s"} pra você`,
    count: n,
  };
}

function applyAnswer(ui: RefinoUi, id: string | undefined, value: string): RefinoUi {
  const next: RefinoUi = structuredClone(ui);
  const q = id
    ? next.questions.find((item) => item.id === id)
    : next.questions.find((item) => !item.answer);
  if (q && value.trim()) q.answer = value.trim();
  next.score = unanswered(next).length ? 0.78 : 0.92;
  return next;
}

function render(fork: Fork): string {
  const ui = uiOf(fork);
  const n = unanswered(ui).length;
  const waitChip = n ? `<span class="chip y">${n} pergunta${n === 1 ? "" : "s"} pra você</span>` : "";
  const pareceres = ui.pareceres
    .map((p) => {
      const av = p.seat === "claude" ? "av c" : "av";
      return `<div class="m"><div class="${av}"><img alt="" src="${SEAT_ICON[p.seat]}"></div>
        <div class="bb"><div class="nm">${escapeHtml(p.role)}<i>${escapeHtml(SEAT_NAME[p.seat])}</i></div>${formatInline(p.text)}</div></div>`;
    })
    .join("");
  const questions = ui.questions
    .map((q, i) => {
      const chips = q.answer
        ? `<span class="chip b">${escapeHtml(q.answer)}</span>`
        : `${q.options
            .map(
              (o) =>
                `<button type="button" class="chip opt" data-act="answer" data-id="${escapeHtml(q.id)}" data-value="${escapeHtml(o)}">${escapeHtml(o)}</button>`,
            )
            .join("")}<button type="button" class="chip opt" data-act="other" data-id="${escapeHtml(q.id)}">outra…</button>`;
      return `<div class="q"><b>${i + 1}.</b> ${escapeHtml(q.text)}<div class="opts">${chips}</div></div>`;
    })
    .join("");
  return `
    <div class="mh">
      <b>refino #${fork.seq}</b> Card · ${escapeHtml(ui.card)}
      ${waitChip}<span class="chip">score ${ui.score.toFixed(2)}</span>
      ${fork.worktree ? `<code>${escapeHtml(fork.worktree)}</code>` : ""}
      <button class="x" id="closeModal" type="button">✕</button>
    </div>
    <div class="mbody">
      <div class="sec">PARECERES</div>
      ${pareceres}
      <div class="sec">ESPERANDO VOCÊ</div>
      ${questions}
    </div>
    <form class="mi" id="forkForm">
      <input name="t" placeholder="Responde ou pergunta algo pro refino… (volta pro chat quando fechar 0.90)" autocomplete="off" />
    </form>`;
}

function applyRefino(fork: Fork, type: string, id: string | undefined, value: string): ViewActionResult | void {
  switch (type) {
    case "answer":
    case "say": {
      const next = applyAnswer(uiOf(fork), id, value);
      if (next.score >= REFINE_DONE_SCORE) {
        return {
          ui: next,
          needsUser: null,
          merge: true,
          summary: `score ${next.score.toFixed(2)} · ${next.questions.map((q) => q.answer ?? "?").join("; ")}`,
        };
      }
      return { ui: next, needsUser: waiting(next) };
    }
    default:
      return;
  }
}

const refino: ViewPlugin = {
  id: "refino",
  label: "refino",
  description: "Refino de um card: pareceres por papel, perguntas de uma tacada, volta ao chat quando o score fecha 0,90.",
  tabs: [],
  parseLink(params) {
    return { card: params.card ?? params.topic ?? "Pickup scheduling" };
  },
  async createFork(params) {
    const card = params.card ?? params.topic ?? "Pickup scheduling";
    const ui = mockUi(card);
    return {
      title: card,
      needsWorktree: true,
      hold: true,
      ui,
      needsUser: waiting(ui) ?? undefined,
      prompt: `Modo refino. Card: ${card}. Worktree isolado. Três pareceres (Produto, Engenharia, Analista) já estão no painel. Não feche o fork até o score chegar a 0.90.`,
    };
  },
  applyAction(fork, action) {
    return applyRefino(fork, action.type, action.id, action.value ?? "");
  },
  render,
};

export default refino;
