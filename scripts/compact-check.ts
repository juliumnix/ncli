#!/usr/bin/env bun
import { loadConfig } from "../src/config";
import { defaultCompactRunner } from "../src/memory/cursor-compact";
import { compactSdkStatus } from "../src/memory/sdk-compact";
import { loadNcliSecrets, missingCompactKeyMessage } from "../src/secrets";

loadNcliSecrets();
const cfg = loadConfig();
if (compactSdkStatus() !== "ok") {
  console.error(`compact:check  ${missingCompactKeyMessage()}`);
  process.exit(2);
}

const line = await defaultCompactRunner(cfg)(
  "Reply with the single word ok. Nothing else.",
  cfg.compactModel,
);
if (!line) {
  console.error("compact:check failed: empty SDK reply");
  process.exit(1);
}
console.log(`compact: cursor-sdk ok · ${cfg.compactModel}`);
console.log(line);
