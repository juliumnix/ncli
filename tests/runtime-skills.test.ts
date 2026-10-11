import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { assemble, MASTER } from "../src/memory/assemble";
import { Memory, mockCompressor } from "../src/memory/store";
import { prepareSpawn } from "../src/mcp/inject";
import { runtimeSkillDirs, skillPrompt } from "../src/skills/catalog";
import { tmpDir } from "./helpers";

const BANNED = ["pstack-codex", "pstack-cursor", "pstack-claude", "ncli/skills/pstack", "poteto-mode", "NCLI_FANOUT"];

function assertClean(label: string, text: string): void {
  for (const needle of BANNED) {
    expect(text.includes(needle), `${label} leaked ${needle}`).toBe(false);
  }
}

test("assembled system and MASTER omit pstack runtime hooks", () => {
  const mem = new Memory({
    dir: tmpDir("rt-sys"),
    nodeBytes: 80,
    viewBytes: 400,
    compressor: mockCompressor(),
  });
  mem.append({ kind: "note", text: "oi" });
  const ctx = assemble(mem);
  assertClean("MASTER", MASTER);
  assertClean("system", ctx.system);
  assertClean("skillPrompt", skillPrompt());
  expect(ctx.system).toContain("ncli/skills/ncli-bus");
  expect(ctx.system).toContain("ncli/skills/emil/");
  expect(ctx.system).toContain("ask / wait");
});

test("prepareSpawn add-dir is runtime skills + emil, never pstack", () => {
  const dataDir = tmpDir("rt-spawn");
  const cfg = loadConfig({ dataDir, repo: dataDir, ncliRoot: process.cwd(), harness: "claude" });
  const inj = prepareSpawn({
    cfg,
    session: "main",
    harness: "claude",
    token: "t",
    mcpUrl: "http://127.0.0.1:9/mcp",
  });
  assertClean("agentsMd", inj.agentsMd);
  expect(inj.addDir.some((d) => d.endsWith("ncli/skills/ncli-bus"))).toBe(true);
  expect(inj.addDir.some((d) => d.endsWith("ncli/skills/emil"))).toBe(true);
  expect(inj.addDir.every((d) => !d.includes("pstack"))).toBe(true);
  expect(inj.addDir.every((d) => !d.endsWith("ncli/skills"))).toBe(true);
  expect(runtimeSkillDirs().every((d) => !d.includes("pstack"))).toBe(true);
});

test("ncli-bus and delegate skills do not name pstack binaries", () => {
  const bus = readFileSync(join(import.meta.dir, "../ncli/skills/ncli-bus/SKILL.md"), "utf8");
  const del = readFileSync(join(import.meta.dir, "../ncli/skills/delegate-to-other-agent/SKILL.md"), "utf8");
  assertClean("ncli-bus", bus);
  assertClean("delegate", del);
  expect(bus).toContain("ask");
  expect(del).toContain("ncli-bus");
});

test("config has no pstack fan-out knobs", () => {
  const cfg = loadConfig();
  expect("pstackCodex" in cfg).toBe(false);
  expect("pstackCursor" in cfg).toBe(false);
  expect("fanout" in cfg).toBe(false);
});
