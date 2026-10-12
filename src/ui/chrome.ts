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
  return TRIO_SEATS.map((seat) => ({
    seat,
    present: Boolean(clis[seat]),
    main: seat === main,
  }));
}

export function detectClis(cfg: { claudeBin: string; codexBin: string; cursorBin: string }): CliPresence {
  return {
    claude: Boolean(Bun.which(cfg.claudeBin)),
    codex: Boolean(Bun.which(cfg.codexBin)),
    cursor: Boolean(Bun.which(cfg.cursorBin)),
  };
}

export type ChromeInput = {
  messageCount: number;
  sparkCount: number;
  compactTokens: number;
  compactRunning: boolean;
  limited: boolean;
  mainHarness: string;
};

export type SessionChrome = {
  showSwitcher: boolean;
  showCompact: boolean;
  showSparks: boolean;
  showViews: boolean;
  showWelcome: boolean;
};

export function sessionChrome(input: ChromeInput): SessionChrome {
  const extraSeat = input.mainHarness !== "claude" && input.mainHarness !== "mock";
  const sparked = input.sparkCount > 0;
  return {
    showSwitcher: input.limited || sparked || extraSeat,
    showCompact: input.compactRunning || input.compactTokens > 0,
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
