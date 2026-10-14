import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
  loadCompactChoice,
  resolveCompactChoice,
  saveCompactChoice,
} from "../src/memory/compact-choice";
import {
  cachedProviderModels,
  CODEX_COMPACT_MODELS,
  COMPACT_MODELS_ERROR_TTL_MS,
  listProviderModels,
  modelListArgv,
  parseModelList,
  pickCheapModel,
  saveModelCache,
} from "../src/memory/compact-models";
import { COMPACT_EVAL, evalDropVsComposer } from "../src/memory/compact-eval";
import { compactPauseLabel, compactSettingsHtml } from "../src/memory/compact-settings";
import { CompactCliError } from "../src/memory/compact-deferred";
import { tmpDir } from "./helpers";

test("compact choice survives a restart and honors NCLI_COMPACT_MODEL", () => {
  const dir = tmpDir("choice");
  saveCompactChoice(dir, { mode: "cli", provider: "codex", model: "from-cli" });
  const again = loadCompactChoice(dir);
  expect(again).toEqual({ mode: "cli", provider: "codex", model: "from-cli" });
  const over = resolveCompactChoice(dir, { NCLI_COMPACT_MODEL: "env-model" });
  expect(over.model).toBe("env-model");
  expect(over.mode).toBe("cli");
  expect(over.provider).toBe("codex");
});

test("selector html names SDK, CLI, providers, model, error, and paused limit", () => {
  const html = compactSettingsHtml({
    choice: { mode: "cli", provider: "codex", model: "mini" },
    models: ["mini", "big"],
    error: "Codex CLI não está instalado (codex).",
    paused: "limit",
  });
  expect(html).toContain("data-compact-mode=\"sdk\"");
  expect(html).toContain("data-compact-mode=\"cli\"");
  expect(html).toContain("data-compact-provider=\"codex\"");
  expect(html).toContain("/icons/openai.svg");
  expect(html).toContain("/icons/claude.svg");
  expect(html).toContain("/icons/cursor.svg");
  expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  expect(html).toContain("mini");
  expect(html).toContain("Codex CLI não está instalado");
  expect(html).toContain("Pausado no limite");
  expect(compactPauseLabel("budget")).toBe("Pausado: limite diário");
});

test("model list is cached so a second open does not spawn the CLI", async () => {
  const dir = tmpDir("models");
  const cfg = loadConfig({ dataDir: dir });
  let calls = 0;
  const first = await cachedProviderModels(dir, "codex", cfg, {
    list: async () => {
      calls += 1;
      return ["mini", "big"];
    },
  });
  expect(first.models).toEqual(["mini", "big"]);
  const second = await cachedProviderModels(dir, "codex", cfg, {
    list: async () => {
      calls += 1;
      return ["nope"];
    },
  });
  expect(calls).toBe(1);
  expect(second.models).toEqual(["mini", "big"]);
  expect(parseModelList('{"models":[{"id":"gpt-mini"},{"id":"gpt-big"}]}')).toEqual(["gpt-mini", "gpt-big"]);
  expect(pickCheapModel(["gpt-big", "gpt-mini"])).toBe("gpt-mini");
});

test("a cached model error expires in 30s and Codex uses a fixed list", async () => {
  const dir = tmpDir("models-ttl");
  const cfg = loadConfig({ dataDir: dir });
  let calls = 0;
  const t0 = 2_000_000;
  const failed = await cachedProviderModels(dir, "claude", cfg, {
    now: t0,
    list: async () => {
      calls += 1;
      throw new CompactCliError("Claude CLI falhou: boom");
    },
  });
  expect(failed.error).toContain("falhou");
  const held = await cachedProviderModels(dir, "claude", cfg, {
    now: t0 + COMPACT_MODELS_ERROR_TTL_MS - 1,
    list: async () => {
      calls += 1;
      return ["haiku"];
    },
  });
  expect(held.error).toContain("falhou");
  expect(calls).toBe(1);
  const again = await cachedProviderModels(dir, "claude", cfg, {
    now: t0 + COMPACT_MODELS_ERROR_TTL_MS + 1,
    list: async () => {
      calls += 1;
      return ["haiku"];
    },
  });
  expect(again.models).toEqual(["haiku"]);
  expect(again.error).toBeUndefined();
  expect(calls).toBe(2);
  expect(COMPACT_MODELS_ERROR_TTL_MS).toBeLessThanOrEqual(30_000);
  let spawned = 0;
  const fixed = await listProviderModels("codex", cfg, {
    spawn: () => {
      spawned += 1;
      throw new Error("codex models must not spawn");
    },
  });
  expect(fixed).toEqual([...CODEX_COMPACT_MODELS]);
  expect(spawned).toBe(0);
  expect(modelListArgv("claude", cfg)).toContain("--list-models");
  expect(modelListArgv("cursor", cfg)).toContain("--list-models");
});

test("a missing CLI is a clear cached error, not an empty silent list", async () => {
  const dir = tmpDir("models-miss");
  const cfg = loadConfig({ dataDir: dir, codexBin: "codex-not-installed" });
  const row = await cachedProviderModels(dir, "codex", cfg, {
    list: async () => {
      throw new CompactCliError("Codex CLI não está instalado (codex-not-installed).");
    },
  });
  expect(row.models).toEqual([]);
  expect(row.error).toContain("não está instalado");
  saveModelCache(dir, row);
  const html = compactSettingsHtml({
    choice: { mode: "cli", provider: "codex", model: "" },
    models: [],
    error: row.error,
  });
  expect(html).toContain("não está instalado");
});

test("selector warns when memory:eval of a model drops versus Composer", () => {
  expect(evalDropVsComposer("composer-2.5")).toBeUndefined();
  expect(evalDropVsComposer("unknown-model")).toBeUndefined();
  const warn = evalDropVsComposer("cheap-mini", {
    ...COMPACT_EVAL,
    "cheap-mini": { viewPresence: 0.2, reachability: 0.6 },
  });
  expect(warn).toContain("memory:eval");
  expect(warn).toContain("Composer");
  const html = compactSettingsHtml({
    choice: { mode: "cli", provider: "codex", model: "cheap-mini" },
    models: ["cheap-mini", "composer-2.5"],
    evalWarn: warn,
  });
  expect(html).toContain("memory:eval");
  expect(html).toContain("class=\"compact-warn\"");
});
