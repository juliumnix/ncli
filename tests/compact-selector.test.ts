import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
  loadCompactChoice,
  resolveCompactChoice,
  saveCompactChoice,
} from "../src/memory/compact-choice";
import { cachedProviderModels, parseModelList, pickCheapModel, saveModelCache } from "../src/memory/compact-models";
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
