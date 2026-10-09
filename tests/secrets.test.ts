import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compactSdkKey, loadNcliSecrets, parseSecretsEnv, redactSecrets } from "../src/secrets";
import { tmpDir } from "./helpers";

test("parseSecretsEnv reads only NCLI_CURSOR_API_KEY and ignores other lines", () => {
  const parsed = parseSecretsEnv(`
# comment
NCLI_CURSOR_API_KEY=sk-from-file
CURSOR_API_KEY=global-must-ignore
NCLI_COMPACT_API_KEY=wrong-name
export NCLI_CURSOR_MODEL=composer-2.5
`);
  expect(parsed).toEqual({ NCLI_CURSOR_API_KEY: "sk-from-file" });
});

test("loadNcliSecrets fills an empty env from ~/.config/ncli/secrets.env and process env wins", () => {
  const home = tmpDir("sec-home");
  mkdirSync(join(home, ".config", "ncli"), { recursive: true });
  writeFileSync(join(home, ".config", "ncli", "secrets.env"), "NCLI_CURSOR_API_KEY=from-file\n", { mode: 0o600 });
  const filled: Record<string, string | undefined> = { HOME: home };
  expect(loadNcliSecrets(filled, home).loaded).toBe(true);
  expect(compactSdkKey(filled)).toBe("from-file");
  const override: Record<string, string | undefined> = { HOME: home, NCLI_CURSOR_API_KEY: "from-env" };
  loadNcliSecrets(override, home);
  expect(compactSdkKey(override)).toBe("from-env");
});

test("redactSecrets never leaves the key in a string that would be logged", () => {
  const env = { NCLI_CURSOR_API_KEY: "super-secret-key" };
  expect(redactSecrets("compact used super-secret-key today", env)).toBe("compact used *** today");
  expect(redactSecrets("compact used super-secret-key today", env)).not.toContain("super-secret-key");
});
