import { loadConfig } from "../../src/config";
import { cursorCompressor, parseNumbered } from "../../src/memory/cursor-compact";
import type { Compressor } from "../../src/memory/store";
import { fakeCursorRunner } from "./run";

export function cursorEvalCompressor(dir: string, opts: {
  budgetTokens?: number;
  skipTokens?: number;
  batch?: number;
  onPrompt?: (prompt: string, model: string) => void;
} = {}): Compressor {
  const cfg = loadConfig({
    dataDir: dir,
    compactBackend: "cursor",
    compactBatch: opts.batch ?? 4,
    compactDebounceMs: 5,
    compactSkipTokens: opts.skipTokens ?? 1,
    compactBudgetTokens: opts.budgetTokens ?? 250000,
    compactModel: "claude-haiku-5-5",
    nodeBytes: 280,
  });
  return cursorCompressor(cfg, async (prompt, model) => {
    opts.onPrompt?.(prompt, model);
    const raw = fakeCursorRunner(prompt);
    const n = Number(/Output (\d+) lines/.exec(prompt)?.[1] ?? 0);
    if (!n) return raw;
    const parsed = parseNumbered(raw, n);
    return parsed.map((line, i) => `${i + 1}. ${line}`).join("\n");
  });
}
