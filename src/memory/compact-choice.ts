import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const COMPACT_MODES = ["sdk", "cli"] as const;
export type CompactMode = (typeof COMPACT_MODES)[number];

export const COMPACT_PROVIDERS = ["codex", "claude", "cursor"] as const;
export type CompactProvider = (typeof COMPACT_PROVIDERS)[number];

export type CompactChoice = {
  mode: CompactMode;
  provider: CompactProvider;
  model: string;
};

export const DEFAULT_COMPACT_CHOICE: CompactChoice = {
  mode: "cli",
  provider: "codex",
  model: "",
};

export const COMPACT_CHOICE_FILE = "compact-choice.json";

export function isCompactMode(v: unknown): v is CompactMode {
  return v === "sdk" || v === "cli";
}

export function isCompactProvider(v: unknown): v is CompactProvider {
  return v === "codex" || v === "claude" || v === "cursor";
}

export function parseCompactChoice(raw: unknown): CompactChoice | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { mode?: unknown; provider?: unknown; model?: unknown };
  if (!isCompactMode(rec.mode) || !isCompactProvider(rec.provider)) return null;
  return {
    mode: rec.mode,
    provider: rec.provider,
    model: typeof rec.model === "string" ? rec.model.trim() : "",
  };
}

export function loadCompactChoice(dir: string): CompactChoice | null {
  const path = join(dir, COMPACT_CHOICE_FILE);
  if (!existsSync(path)) return null;
  try {
    return parseCompactChoice(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function saveCompactChoice(dir: string, choice: CompactChoice): CompactChoice {
  mkdirSync(dir, { recursive: true });
  const next: CompactChoice = {
    mode: choice.mode,
    provider: choice.provider,
    model: choice.model.trim(),
  };
  const path = join(dir, COMPACT_CHOICE_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next)}\n`);
  renameSync(tmp, path);
  return next;
}

export function resolveCompactChoice(
  dir: string,
  env: Record<string, string | undefined> = process.env,
  fallback: CompactChoice = DEFAULT_COMPACT_CHOICE,
): CompactChoice {
  const saved = loadCompactChoice(dir) ?? fallback;
  const model = (env.NCLI_COMPACT_MODEL ?? "").trim();
  if (model) return { ...saved, model };
  return saved;
}

export function choiceLabel(choice: CompactChoice): string {
  if (choice.mode === "sdk") return choice.model ? `SDK · ${choice.model}` : "SDK";
  const who = choice.provider === "codex" ? "Codex" : choice.provider === "claude" ? "Claude" : "Cursor";
  return choice.model ? `CLI ${who} · ${choice.model}` : `CLI ${who}`;
}
