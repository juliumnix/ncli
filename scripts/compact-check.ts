#!/usr/bin/env bun
import { loadConfig } from "../src/config";
import { parseCursorPrint } from "../src/memory/cursor-compact";

const cfg = loadConfig();
const bin = cfg.cursorBin;
if (!Bun.which(bin)) {
  console.error(`compact:check  ${bin} not on PATH. Install Cursor CLI and retry.`);
  process.exit(2);
}

const prompt = "Reply with the single word ok. Nothing else.";
const proc = Bun.spawn(
  [bin, "--print", "--model", cfg.compactModel, "--output-format", "json", "--trust", prompt],
  { stdout: "pipe", stderr: "pipe" },
);
const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const code = await proc.exited;
const line = parseCursorPrint(stdout);
if (code !== 0 || !line) {
  console.error(`compact:check failed (${code})`);
  if (stderr.trim()) console.error(stderr.trim());
  process.exit(1);
}
console.log(`compact:check  ${cfg.compactModel}`);
console.log(line);
