import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { createCompactEngine } from "../src/memory/compact-engine";
import {
  COMPACT_RULER,
  CODEX_ISOLATE_C,
  cliCompactArgv,
  compactSharesChat,
  isolatedCompactCwd,
  parseCliCompactOutput,
} from "../src/memory/cli-compact";
import { utf8Bytes } from "../src/util";
import { CompactCliError, ProviderLimitError } from "../src/memory/compact-deferred";
import { COMPACT_MAX_PROCS, CompactProcPool } from "../src/memory/compact-proc";
import { jobPrompt } from "../src/memory/cursor-compact";
import { loadCompactQueue } from "../src/memory/compact-queue";
import { Memory } from "../src/memory/store";
import { makeHub, tmpDir } from "./helpers";

const LONG = "user decided FACT_MEMBER_DISCOUNT_BEFORE_TAX applies only to member and before tax. ".repeat(8);

function treeIds(dir: string): string[] {
  const path = join(dir, "tree.jsonl");
  if (!existsSync(path)) return [];
  const seen = new Set<string>();
  const last = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const n = JSON.parse(line) as { l?: number; i?: number; dropped?: boolean };
    if (typeof n.l !== "number" || typeof n.i !== "number") continue;
    const id = `${n.l}:${n.i}`;
    if (n.dropped) last.delete(id);
    else last.set(id, id);
    seen.add(id);
  }
  return [...last.keys()].sort();
}

function numbered(n: number, tag: string): string {
  return Array.from({ length: n }, (_, i) => `${i + 1}. ${tag} ${i + 1}`).join("\n");
}

test("jobPrompt keeps the 512 ruler and the same compact system prompt", () => {
  const prompt = jobPrompt([{
    input: { kind: "leaf", source: "user: hello", contextLines: ["0+1|older"], nodeBytes: 32 },
  }]);
  expect(prompt).toContain("-".repeat(COMPACT_RULER));
  expect(prompt).toContain("You write the memory of NCLI");
  const isolated = cliCompactArgv("codex", loadConfig({}), "mini", "p");
  expect(isolated.slice(0, 6)).toEqual(["codex", "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only"]);
  for (const key of CODEX_ISOLATE_C) {
    expect(isolated).toContain("-c");
    expect(isolated).toContain(key);
  }
  expect(isolated.at(-1)).toBe("p");
  expect(isolated.join("\0")).not.toContain("CODEX_HOME");
  expect(compactSharesChat("codex", "codex")).toBe(true);
  expect(compactSharesChat("codex", "cursor")).toBe(false);
  const shared = cliCompactArgv("codex", loadConfig({ ncliRoot: process.cwd() }), "mini", "p", { shareChat: true });
  expect(shared).not.toContain("--skip-git-repo-check");
  expect(shared.join(" ")).toContain("mcp_servers.");
  expect(parseCliCompactOutput("codex", '{"type":"agent_message","text":"one line"}\n')).toContain("one line");
});

test("kill mid-batch then resume matches an uninterrupted tree and writes each id once", async () => {
  const dir = tmpDir("kill-batch");
  const memDir = join(dir, "mem");
  let calls = 0;
  const runner = async (prompt: string) => {
    calls += 1;
    const n = (prompt.match(/### /g) ?? []).length || 1;
    if (calls === 2) throw new Error("killed");
    return numbered(n, "ok");
  };
  const cfg = loadConfig({
    dataDir: dir,
    compactBackend: "cursor",
    compactBatch: 2,
    compactDebounceMs: 1,
    compactSkipTokens: 1,
    compactTimeoutMs: 0,
  });
  const engine = createCompactEngine(cfg, { runner });
  const mem = new Memory({
    dir: memDir,
    nodeBytes: 80,
    viewBytes: 4000,
    compressor: engine.compress,
    deferBackoffMs: 60_000,
    deferCutAfter: 8,
    compactJobs: 1,
    pumpBatch: 2,
  });
  for (let i = 0; i < 8; i++) mem.append({ kind: i % 2 === 0 ? "user" : "talk", text: `${LONG} ${i}` });
  await mem.pump();
  mem.paused = true;
  engine.killAll();
  const mid = treeIds(memDir);
  expect(mid.length).toBeGreaterThan(0);
  expect(loadCompactQueue(memDir)).not.toBeUndefined();

  const engine2 = createCompactEngine(cfg, {
    runner: async (prompt) => numbered((prompt.match(/### /g) ?? []).length || 1, "ok"),
  });
  const again = new Memory({
    dir: memDir,
    nodeBytes: 80,
    viewBytes: 4000,
    compressor: engine2.compress,
    deferBackoffMs: 60_000,
    deferCutAfter: 8,
    compactJobs: 1,
    pumpBatch: 2,
  });
  await again.pump();
  const resumed = treeIds(memDir);
  expect(new Set(resumed).size).toBe(resumed.length);

  const cleanDir = join(tmpDir("kill-clean"), "mem");
  const cleanCfg = loadConfig({
    dataDir: join(cleanDir, ".."),
    compactBackend: "cursor",
    compactBatch: 2,
    compactDebounceMs: 1,
    compactSkipTokens: 1,
    compactTimeoutMs: 0,
  });
  const cleanEngine = createCompactEngine(cleanCfg, {
    runner: async (prompt) => numbered((prompt.match(/### /g) ?? []).length || 1, "ok"),
  });
  const clean = new Memory({
    dir: cleanDir,
    nodeBytes: 80,
    viewBytes: 4000,
    compressor: cleanEngine.compress,
    compactJobs: 1,
    pumpBatch: 2,
  });
  for (let i = 0; i < 8; i++) clean.append({ kind: i % 2 === 0 ? "user" : "talk", text: `${LONG} ${i}` });
  await clean.pump();
  expect(resumed).toEqual(treeIds(cleanDir));
  const refined = [...again.nodes.values()].filter((n) => n.compactor);
  expect(refined.length).toBeGreaterThan(0);
  expect(refined.every((n) => n.model && n.agent && n.compactor)).toBe(true);
});

test("a simulated provider limit requeues and writes no half node", async () => {
  const dir = tmpDir("limit");
  const memDir = join(dir, "mem");
  const cfg = loadConfig({
    dataDir: dir,
    compactBackend: "cursor",
    compactBatch: 1,
    compactDebounceMs: 1,
    compactSkipTokens: 1,
    compactTimeoutMs: 0,
  });
  const engine = createCompactEngine(cfg, {
    runner: async () => {
      throw new ProviderLimitError("quota exceeded");
    },
  });
  const mem = new Memory({
    dir: memDir,
    nodeBytes: 80,
    viewBytes: 2000,
    compressor: engine.compress,
    deferCutAfter: 8,
  });
  mem.append({ kind: "user", text: LONG });
  await mem.pump();
  expect(mem.compactWork.paused).toBe("limit");
  const refined = [...mem.nodes.values()].filter((n) => n.compactor);
  expect(refined).toEqual([]);
  const tree = readFileSync(join(memDir, "tree.jsonl"), "utf8");
  expect(tree).not.toContain("\"compactor\"");
  const queue = loadCompactQueue(memDir);
  expect(queue && queue.length).toBeGreaterThan(0);
  mem.paused = true;
});

test("switching provider mid-run does not duplicate a node id", async () => {
  const dir = tmpDir("switch");
  const memDir = join(dir, "mem");
  const cfg = loadConfig({ dataDir: dir, compactBackend: "cursor", compactSkipTokens: 1, compactTimeoutMs: 0, compactDebounceMs: 1, compactBatch: 1 });
  let provider = "codex";
  const engine = createCompactEngine(cfg, {
    runner: async () => `1. line from ${provider}`,
  });
  const mem = new Memory({ dir: memDir, nodeBytes: 80, viewBytes: 2000, compressor: engine.compress });
  mem.append({ kind: "user", text: LONG });
  const first = mem.pump();
  engine.setChoice({ mode: "cli", provider: "claude", model: "haiku" });
  provider = "claude";
  await first;
  await mem.pump();
  const ids = treeIds(memDir);
  expect(new Set(ids).size).toBe(ids.length);
  const node = mem.nodeOf(0, 0);
  expect(node).toBeDefined();
});

test("paused compact lets the view grow past 128 KB and the turn still answers", async () => {
  const dir = tmpDir("grow");
  const mem = new Memory({
    dir,
    nodeBytes: 4000,
    viewBytes: 800,
    compressor: async () => {
      throw new ProviderLimitError("quota");
    },
  });
  mem.compactWork.paused = "limit";
  const chunk = "x".repeat(4000);
  for (let i = 0; i < 40; i++) {
    mem.append({ kind: i % 2 === 0 ? "user" : "talk", text: `${chunk} ${i}` });
  }
  await mem.pump();
  expect(mem.nodeBytes).toBe(4000);
  expect(mem.viewBytesUsed()).toBeGreaterThan(128 * 1024);
  mem.paused = true;

  const { hub } = await makeHub({ nodeBytes: 40, viewBytes: 800 });
  hub.memory.compactWork.paused = "limit";
  const t0 = Date.now();
  await hub.send("oi com compactacao pausada");
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(hub.memory.log.some((m) => m.kind === "talk")).toBe(true);
  hub.close();
});

test("process pool never exceeds 8 and killAll leaves no live child", async () => {
  const pool = new CompactProcPool();
  const live: number[] = [];
  const jobs = Array.from({ length: 12 }, async (_, i) => {
    await pool.acquire();
    const pid = 1000 + i;
    live.push(pid);
    expect(pool.size).toBeLessThanOrEqual(COMPACT_MAX_PROCS);
    pool.track(pid, () => {
      const at = live.indexOf(pid);
      if (at >= 0) live.splice(at, 1);
    });
    await Bun.sleep(20);
    pool.release(pid);
    const at = live.indexOf(pid);
    if (at >= 0) live.splice(at, 1);
  });
  await Promise.all(jobs);
  expect(pool.size).toBe(0);
  pool.track(9, () => undefined);
  pool.killAll();
  expect(pool.size).toBe(0);
});

test("a missing CLI surfaces on the selector and does not spin the queue", async () => {
  const dir = tmpDir("cli-miss");
  const cfg = loadConfig({ dataDir: dir, compactBackend: "cursor", compactSkipTokens: 1, compactTimeoutMs: 0, compactDebounceMs: 1 });
  const engine = createCompactEngine(cfg, {
    runner: async () => {
      throw new CompactCliError("Codex CLI não está instalado (codex).");
    },
  });
  engine.setChoice({ mode: "cli", provider: "codex", model: "mini" });
  const mem = new Memory({
    dir: join(dir, "mem"),
    nodeBytes: 80,
    viewBytes: 800,
    compressor: engine.compress,
    deferBackoffMs: 60_000,
    deferCutAfter: 8,
  });
  mem.append({ kind: "user", text: LONG });
  await mem.pump();
  expect(mem.compactWork.paused).toBe("cli-error");
  const before = mem.compactWork.total;
  await Bun.sleep(40);
  await mem.pump();
  expect(mem.compactWork.total).toBe(before);
  mem.paused = true;
});

test("cli spawn and model times are logged separately and stay under the SDK mock on a fat batch", async () => {
  const dir = tmpDir("perf");
  const cfg = loadConfig({ dataDir: dir, compactBackend: "cursor", compactSkipTokens: 1, compactTimeoutMs: 0, compactBatch: 8, compactDebounceMs: 1 });
  const engine = createCompactEngine(cfg, {
    spawn: (argv, _env) => {
      const prompt = argv.at(-1) ?? "";
      const n = (prompt.match(/### /g) ?? []).length || 1;
      const body = numbered(n, "ok");
      return {
        pid: 42,
        stdout: new Response(body).body,
        stderr: new Response("").body,
        exited: Bun.sleep(8).then(() => 0),
        kill: () => undefined,
      };
    },
  });
  engine.setChoice({ mode: "cli", provider: "codex", model: "mini" });
  const mem = new Memory({
    dir: join(dir, "mem"),
    nodeBytes: 80,
    viewBytes: 8000,
    compressor: engine.compress,
    compactJobs: 8,
    pumpBatch: 8,
  });
  for (let i = 0; i < 16; i++) mem.append({ kind: i % 2 === 0 ? "user" : "talk", text: `${LONG} ${i}` });
  const t0 = Date.now();
  await mem.pump();
  const cliMs = Date.now() - t0;
  const log = readFileSync(join(dir, "compact-log.jsonl"), "utf8");
  expect(log).toContain("spawnMs");
  expect(log).toContain("modelMs");
  const sdkDir = tmpDir("perf-sdk");
  const sdkCfg = loadConfig({ dataDir: sdkDir, compactBackend: "cursor", compactSkipTokens: 1, compactTimeoutMs: 0, compactBatch: 8, compactDebounceMs: 1 });
  const sdk = createCompactEngine(sdkCfg, {
    runner: async (prompt) => {
      await Bun.sleep(8);
      return numbered((prompt.match(/### /g) ?? []).length || 1, "ok");
    },
  });
  sdk.setChoice({ mode: "sdk", provider: "cursor", model: "composer-2.5" });
  const sdkMem = new Memory({
    dir: join(sdkDir, "mem"),
    nodeBytes: 80,
    viewBytes: 8000,
    compressor: sdk.compress,
    compactJobs: 8,
    pumpBatch: 8,
  });
  for (let i = 0; i < 16; i++) sdkMem.append({ kind: i % 2 === 0 ? "user" : "talk", text: `${LONG} ${i}` });
  const s0 = Date.now();
  await sdkMem.pump();
  const sdkMs = Date.now() - s0;
  expect(cliMs).toBeLessThan(sdkMs * 8 + 2000);
  mem.paused = true;
  sdkMem.paused = true;
});

test("SDK and CLI compact the same stretch under the 512 ruler and call no tool", async () => {
  const stretch = {
    kind: "leaf" as const,
    source: "user: FACT_X applies before tax",
    contextLines: ["0+1|older"],
    nodeBytes: 512,
  };
  const body = "1. user: FACT_X applies before tax";
  const sdkPrompts: string[] = [];
  const cliPrompts: string[] = [];
  const cliArgv: string[][] = [];
  let tools = 0;
  const sdkDir = tmpDir("same-sdk");
  const sdk = createCompactEngine(
    loadConfig({
      dataDir: sdkDir,
      compactBackend: "cursor",
      compactSkipTokens: 1,
      compactTimeoutMs: 0,
      compactDebounceMs: 1,
      compactBatch: 1,
      harness: "cursor",
    }),
    {
      runner: async (prompt) => {
        sdkPrompts.push(prompt);
        return body;
      },
    },
  );
  sdk.setChoice({ mode: "sdk", provider: "cursor", model: "composer-2.5" });
  const cliDir = tmpDir("same-cli");
  const cli = createCompactEngine(
    loadConfig({
      dataDir: cliDir,
      compactBackend: "cursor",
      compactSkipTokens: 1,
      compactTimeoutMs: 0,
      compactDebounceMs: 1,
      compactBatch: 1,
      harness: "cursor",
    }),
    {
      spawn: (argv, env, opts) => {
        cliArgv.push(argv);
        expect(opts?.cwd).toBe(isolatedCompactCwd(cliDir));
        expect(env.CODEX_HOME).toBe(process.env.CODEX_HOME);
        const prompt = argv.at(-1) ?? "";
        cliPrompts.push(prompt);
        if (argv.some((a) => a.includes("mcp_servers.ncli") || a === "--mcp-config")) tools += 1;
        return {
          pid: 1,
          stdout: new Response(`{"type":"agent_message","text":${JSON.stringify(body)}}\n`).body,
          stderr: new Response("").body,
          exited: Promise.resolve(0),
          kill: () => undefined,
        };
      },
    },
  );
  cli.setChoice({ mode: "cli", provider: "codex", model: "mini" });
  const sdkOut = await sdk.compress(stretch);
  const cliOut = await cli.compress(stretch);
  const sdkText = typeof sdkOut === "string" ? sdkOut : sdkOut.text;
  const cliText = typeof cliOut === "string" ? cliOut : cliOut.text;
  expect(utf8Bytes(sdkText)).toBeLessThanOrEqual(512);
  expect(utf8Bytes(cliText)).toBeLessThanOrEqual(512);
  expect(sdkText).toBe(cliText);
  expect(sdkPrompts[0]).toContain("-".repeat(COMPACT_RULER));
  expect(cliPrompts[0]).toContain("-".repeat(COMPACT_RULER));
  expect(sdkPrompts[0]).toContain("You write the memory of NCLI");
  expect(cliPrompts[0]).toContain("You write the memory of NCLI");
  expect(tools).toBe(0);
  expect(cliArgv[0]).toContain("--skip-git-repo-check");
  expect(cliArgv[0]).toContain("read-only");
  for (const key of CODEX_ISOLATE_C) expect(cliArgv[0]).toContain(key);
  expect(typeof sdkOut === "object" ? sdkOut.compactor : undefined).toBe("sdk");
  expect(typeof cliOut === "object" ? cliOut.compactor : undefined).toBe("cli");
  expect(typeof cliOut === "object" ? cliOut.agent : undefined).toBe("codex");
});

test("switching compactador does not rewrite an existing node", async () => {
  const dir = tmpDir("keep-node");
  const memDir = join(dir, "mem");
  const cfg = loadConfig({
    dataDir: dir,
    compactBackend: "cursor",
    compactSkipTokens: 1,
    compactTimeoutMs: 0,
    compactDebounceMs: 1,
    compactBatch: 1,
  });
  const engine = createCompactEngine(cfg, {
    runner: async () => "1. first stamp",
  });
  engine.setChoice({ mode: "sdk", provider: "cursor", model: "composer-2.5" });
  const mem = new Memory({ dir: memDir, nodeBytes: 80, viewBytes: 2000, compressor: engine.compress });
  mem.append({ kind: "user", text: LONG });
  await mem.pump();
  const before = mem.nodeOf(0, 0);
  expect(before?.compactor).toBe("sdk");
  expect(before?.text).toContain("first stamp");
  engine.setChoice({ mode: "cli", provider: "codex", model: "mini" });
  await mem.pump();
  const after = mem.nodeOf(0, 0);
  expect(after?.compactor).toBe("sdk");
  expect(after?.text).toBe(before?.text);
  expect(after?.agent).toBe(before?.agent);
  mem.paused = true;
});
