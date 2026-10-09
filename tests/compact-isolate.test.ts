import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { cursorCliConfigPath, cursorPollutionWarning, withUnchangedFile } from "../src/memory/cli-config";
import { cursorCompressor, defaultCompactRunner } from "../src/memory/cursor-compact";
import { tmpDir } from "./helpers";

const LONG = "user decided FACT_MEMBER_DISCOUNT_BEFORE_TAX applies only to member and before tax. ".repeat(4);
const PLANTED = '{"model":{"defaultModel":"composer-2.5"}}\n';

function plantCliConfig(home: string): string {
  const path = cursorCliConfigPath(home);
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(path, PLANTED);
  return path;
}

test("SDK compact runner leaves a planted cli-config.json byte-identical even if the call writes Haiku", async () => {
  const home = tmpDir("iso-home");
  const dataDir = tmpDir("iso-data");
  const path = plantCliConfig(home);
  const before = readFileSync(path);
  const cfg = loadConfig({ dataDir, compactSkipTokens: 1, compactBatch: 1, repo: dataDir });
  let seenKey = "";
  const runner = defaultCompactRunner(cfg, {
    home,
    env: { NCLI_CURSOR_API_KEY: "ncli-only-key" },
    sdk: async (_prompt, model, key) => {
      seenKey = key;
      writeFileSync(path, '{"model":{"defaultModel":"claude-haiku-5-5-low"}}\n');
      expect(model).toBe("claude-haiku-5-5-low");
      return "1. one line memory";
    },
  });
  const compact = cursorCompressor(cfg, runner);
  const line = await compact({ kind: "leaf", source: LONG, contextLines: [], nodeBytes: 140 });
  expect(line).toContain("one line memory");
  expect(seenKey).toBe("ncli-only-key");
  expect(readFileSync(path)).toEqual(before);
  expect(readFileSync(path, "utf8")).toBe(PLANTED);
});

test("withUnchangedFile restores bytes after a writer mutates the file", async () => {
  const home = tmpDir("guard-home");
  const path = plantCliConfig(home);
  const before = readFileSync(path);
  await withUnchangedFile(path, async () => {
    writeFileSync(path, "mutated");
    expect(readFileSync(path, "utf8")).toBe("mutated");
  });
  expect(readFileSync(path)).toEqual(before);
});

test("pollution warning names the file and does not claim a silent repair", () => {
  const home = tmpDir("warn-home");
  const path = plantCliConfig(home);
  writeFileSync(path, '{"model":{"defaultModel":"claude-haiku-5-5-low"}}\n');
  const text = cursorPollutionWarning({
    cliConfigPath: path,
    compactModel: "claude-haiku-5-5-low",
    original: "composer-2.5",
  });
  expect(text).toContain(path);
  expect(text).toContain("claude-haiku-5-5-low");
  expect(text).toContain("Original value: composer-2.5");
  expect(text).toContain("will not rewrite");
  expect(cursorPollutionWarning({
    cliConfigPath: path,
    compactModel: "claude-haiku-5-5-low",
  })).toContain("Original value is not known");
});

test("a clean composer default does not warn", () => {
  const home = tmpDir("clean-home");
  const path = plantCliConfig(home);
  expect(cursorPollutionWarning({
    cliConfigPath: path,
    compactModel: "claude-haiku-5-5-low",
  })).toBeNull();
});
