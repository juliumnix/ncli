export type CliPresence = { claude: boolean; codex: boolean; cursor: boolean };

export type TrioSeatId = "claude" | "codex" | "cursor";

export type TrioSeat = {
  seat: TrioSeatId;
  present: boolean;
  main: boolean;
};

const TRIO_SEATS: TrioSeatId[] = ["claude", "codex", "cursor"];

export function agentTrio(clis: CliPresence, mainHarness: string): TrioSeat[] {
  const main: TrioSeatId =
    mainHarness === "codex" || mainHarness === "cursor" ? mainHarness : "claude";
  return TRIO_SEATS.map((seat) => {
    const present = Boolean(clis[seat]);
    return {
      seat,
      present,
      main: seat === main && present,
    };
  });
}

let clisKey = "";
let clisCache: CliPresence | null = null;

export function detectClis(cfg: { claudeBin: string; codexBin: string; cursorBin: string }): CliPresence {
  const key = `${cfg.claudeBin}\0${cfg.codexBin}\0${cfg.cursorBin}`;
  if (clisCache && clisKey === key) return clisCache;
  clisCache = {
    claude: Boolean(Bun.which(cfg.claudeBin)),
    codex: Boolean(Bun.which(cfg.codexBin)),
    cursor: Boolean(Bun.which(cfg.cursorBin)),
  };
  clisKey = key;
  return clisCache;
}

export type ChromeInput = {
  messageCount: number;
  sparkCount: number;
  compactTokens: number;
  compactRunning: boolean;
  limited: boolean;
  mainHarness: string;
  importing?: boolean;
};

export type SessionChrome = {
  showSwitcher: boolean;
  showCompact: boolean;
  showSparks: boolean;
  showViews: boolean;
  showWelcome: boolean;
};

export function compactSpendLabel(tokensToday: number, budget: number): string | null {
  if (budget <= 0) return null;
  const k = Math.round(tokensToday / 100) / 10;
  const b = Math.round(budget / 1000);
  return `${k}k/${b}k`;
}

export function sessionChrome(input: ChromeInput): SessionChrome {
  const sparked = input.sparkCount > 0;
  return {
    showSwitcher: true,
    showCompact: input.compactRunning,
    showSparks: sparked,
    showViews: sparked,
    showWelcome: input.messageCount === 0,
  };
}

export function userHelp(): string {
  return [
    "`/help` mostra esta lista",
    "`/?` faz o mesmo",
    "Cola o URL de um pull request do GitHub pra abrir o review",
    "`/ncli import claude` traz o histórico desse CLI",
    "`/ncli import codex` traz o histórico desse CLI",
    "`/ncli import cursor` traz o histórico desse CLI",
  ].join("\n");
}
