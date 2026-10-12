import type { ImportSource } from "./types";

export type ImportProgress = {
  source: ImportSource;
  done: number;
  total: number;
};

const NAMES: Record<ImportSource, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

export function importPct(done: number, total: number): number | null {
  if (total <= 0) return done > 0 ? 100 : null;
  return Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
}

export function formatImportChip(source: ImportSource, progress?: ImportProgress): string {
  if (!progress) return `trazer ${NAMES[source]}`;
  const pct = importPct(progress.done, progress.total);
  return pct === null ? "trazendo…" : `trazendo… ${pct}%`;
}
