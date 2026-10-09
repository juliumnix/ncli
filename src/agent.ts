import type { SeatId } from "./types";

export interface AgentMeta {
  id: SeatId;
  name: string;
  src: string;
}

export const AGENT_META: Record<SeatId, AgentMeta> = {
  claude: { id: "claude", name: "Claude", src: "/icons/claude.svg" },
  codex: { id: "codex", name: "Codex", src: "/icons/openai.svg" },
  cursor: { id: "cursor", name: "Cursor", src: "/icons/cursor.svg" },
};

export function seatOf(id: string | undefined): SeatId {
  if (id === "codex" || id === "cursor" || id === "claude") return id;
  return "claude";
}

export function displayModel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const named = raw.match(/(opus|sonnet|haiku)[^\d]*(\d+)(?:[.-](\d+))?/i);
  if (named) {
    const head = named[1]![0]!.toUpperCase() + named[1]!.slice(1).toLowerCase();
    return named[3] ? `${head} ${named[2]}.${named[3]}` : `${head} ${named[2]}`;
  }
  const gpt = raw.match(/gpt-?(\d+)(?:[.-](\d+))?(-[a-z0-9]+)?/i);
  if (gpt) {
    const base = gpt[2] ? `GPT ${gpt[1]}.${gpt[2]}` : `GPT ${gpt[1]}`;
    return gpt[3] ? `${base}${gpt[3]}` : base;
  }
  return raw.replace(/^claude-?/i, "").replace(/-\d{8}$/, "") || raw;
}

export function agentLabel(seat: SeatId, model?: string): string {
  const name = AGENT_META[seat].name;
  const shown = displayModel(model);
  return shown ? `${name} · ${shown}` : name;
}

export function toolTitle(name: string, input: unknown): string {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  switch (name) {
    case "Read":
    case "read_file":
      return `Read ${shortPath(o.path ?? o.file_path ?? o.file)}`;
    case "Edit":
    case "StrReplace":
    case "Write":
      return `${name} ${shortPath(o.path ?? o.file_path ?? o.file)}`;
    case "Bash":
    case "shell":
    case "command":
      return `Bash \`${shortCmd(o.command ?? o.cmd)}\``;
    case "ask":
      return `ask → ${String(o.agent ?? o.to ?? "?")}`;
    case "wait":
      return `wait ${String(o.ticket ?? o.tickets ?? "")}`.trim();
    case "zoom":
      return `zoom(${o.id}+${o.n})`;
    case "date":
      return `date(#${o.id})`;
    case "ncli.render":
      return `ncli.render(${o.kind ?? "?"})`;
    default:
      return name;
  }
}

function shortPath(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "?";
  const parts = s.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || s;
}

function shortCmd(v: unknown): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "…";
  return s.length > 48 ? `${s.slice(0, 45)}…` : s;
}
