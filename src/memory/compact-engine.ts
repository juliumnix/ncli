import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NcliConfig } from "../config";
import { haikuCompressor } from "./compact";
import { CompactHold } from "./compact-deferred";
import {
  DEFAULT_COMPACT_CHOICE,
  resolveCompactChoice,
  saveCompactChoice,
  type CompactChoice,
  type CompactProvider,
} from "./compact-choice";
import { cachedProviderModels, pickCheapModel, type CompactModelLister } from "./compact-models";
import { CompactProcPool, type CompactProcTiming, type CompactSpawn } from "./compact-proc";
import { compactAsk, compactSharesChat, runCliCompact, type CliCompactDeps } from "./cli-compact";
import {
  compactSnapshot,
  cursorCompressor,
  defaultCompactRunner,
  type CompactListener,
  type CompactProgress,
  type CompactRunner,
} from "./cursor-compact";
import { mockCompressor, type CompactInput, type Compressor } from "./store";

export type CompactEngine = {
  compress: Compressor;
  choice: () => CompactChoice;
  setChoice: (next: Partial<CompactChoice>) => CompactChoice;
  status: () => CompactProgress;
  models: () => Promise<{ models: string[]; error?: string }>;
  killAll: () => void;
  close: () => void;
};

export function createCompactEngine(
  cfg: NcliConfig,
  opts: {
    runner?: CompactRunner;
    onProgress?: CompactListener;
    spawn?: CompactSpawn;
    list?: CompactModelLister;
  } = {},
): CompactEngine {
  const pool = new CompactProcPool();
  let choice = resolveCompactChoice(cfg.dataDir, process.env, DEFAULT_COMPACT_CHOICE);
  if (!choice.model) choice = { ...choice, model: cfg.compactModel };
  let last: CompactProgress = compactSnapshot(cfg);
  last = { ...last, model: choice.model };
  let lastMeta: { compactor: "sdk" | "cli"; agent: string; model: string } | null = null;
  const cliDeps: CliCompactDeps = {
    spawn: opts.spawn,
    pool,
    onTiming: (row) => logTiming(cfg.dataDir, row),
  };

  const onProgress: CompactListener = (ev) => {
    last = {
      ...ev,
      model: choice.model,
      error: ev.error,
      paused: ev.paused,
    };
    opts.onProgress?.(last);
  };

  const run: CompactRunner = async (prompt, model) => {
    lastMeta = {
      compactor: choice.mode,
      agent: choice.mode === "sdk" ? "cursor" : choice.provider,
      model: model || choice.model,
    };
    const shareChat = choice.mode === "cli" && compactSharesChat(choice.provider, cfg.harness);
    const ask = compactAsk(prompt, shareChat);
    if (opts.runner) return opts.runner(ask, model || choice.model);
    if (choice.mode === "sdk") {
      return defaultCompactRunner(cfg)(ask, model || choice.model);
    }
    try {
      return await runCliCompact(choice.provider, cfg, ask, model || choice.model, { ...cliDeps, shareChat });
    } catch (err) {
      if (err instanceof CompactHold) {
        const paused = err.reason === "limit" || err.reason === "budget" ? err.reason : undefined;
        const error = err.reason === "cli-error" ? err.detail || err.message : undefined;
        onProgress(compactSnapshot(cfg, false, 0, error ?? (err.detail || err.message), paused));
        last = { ...last, error: error ?? last.error, paused: paused ?? last.paused };
      }
      throw err;
    }
  };

  const backend = pickBackend(cfg, run, onProgress);

  const engine: CompactEngine = {
    compress: async (input: CompactInput) => {
      const text = await backend(input);
      if (lastMeta) return { text, ...lastMeta };
      return text;
    },
    choice: () => choice,
    setChoice: (next) => {
      pool.killAll();
      choice = saveCompactChoice(cfg.dataDir, {
        mode: next.mode ?? choice.mode,
        provider: next.provider ?? choice.provider,
        model: next.model ?? choice.model,
      });
      cfg.compactModel = choice.model || cfg.compactModel;
      last = { ...last, model: choice.model, error: undefined };
      onProgress(last);
      return choice;
    },
    status: () => ({ ...last, model: choice.model }),
    models: async () => {
      if (choice.mode === "sdk") {
        return { models: choice.model ? [choice.model] : [] };
      }
      const cache = await cachedProviderModels(cfg.dataDir, choice.provider, cfg, {
        spawn: opts.spawn,
        list: opts.list,
        pool,
      });
      if (cache.error) {
        last = { ...last, error: cache.error };
        onProgress(last);
      }
      if (!choice.model && cache.models.length) {
        const cheap = pickCheapModel(cache.models);
        if (cheap) engine.setChoice({ model: cheap });
      }
      return { models: cache.models, error: cache.error };
    },
    killAll: () => pool.killAll(),
    close: () => pool.killAll(),
  };
  return engine;
}

function pickBackend(cfg: NcliConfig, run: CompactRunner, onProgress: CompactListener): Compressor {
  switch (cfg.compactBackend) {
    case "mock":
      return mockCompressor();
    case "claude":
      return haikuCompressor(cfg, run);
    case "cursor":
    case "auto":
      if (cfg.compactBackend === "auto" && cfg.harness === "mock") return mockCompressor();
      return cursorCompressor(cfg, run, onProgress);
    default: {
      const _n: never = cfg.compactBackend;
      return mockCompressor();
    }
  }
}

function logTiming(dir: string, row: CompactProcTiming & { provider: CompactProvider }): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, "compact-log.jsonl"),
    `${JSON.stringify({ t: new Date().toISOString(), ...row })}\n`,
  );
}
