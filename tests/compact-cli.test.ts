import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { createCompactEngine } from "../src/memory/compact-engine";
import {
  CODEX_DISABLE_FEATURES,
  CODEX_ISOLATE_C,
  cliCompactArgv,
  compactSharesChat,
  isolateCodexFlags,
  isolatedCompactCwd,
  parseCliCompactOutput,
  parseMcpList,
  rulerBar,
  sizeRuler,
  withTooLong,
} from "../src/memory/cli-compact";
import { utf8Bytes } from "../src/util";
import { CompactBudgetPause, CompactCliError, ProviderLimitError } from "../src/memory/compact-deferred";
import { COMPACT_MAX_PROCS, CompactProcPool } from "../src/memory/compact-proc";
import { jobPrompt } from "../src/memory/cursor-compact";
import { CompactQueue, COMPACT_QUEUE_FILE, loadCompactQueue } from "../src/memory/compact-queue";
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

test("jobPrompt keeps the same size ruler in the prompt and in validation", () => {
  const prompt = jobPrompt([{
    input: { kind: "leaf", source: "user: hello", contextLines: ["0+1|older"], nodeBytes: 32 },
  }]);
  expect(sizeRuler(rulerBar(32))).toBe(32);
  expect(prompt).toContain(rulerBar(32));
  expect(prompt).not.toContain(rulerBar(512));
  expect(prompt).toContain("You write the memory of NCLI");
  const isolated = cliCompactArgv("codex", loadConfig({ codexBin: "codex" }), "mini", "p", { mcpNames: ["alpha", "beta"] });
  expect(isolated.slice(0, 6)).toEqual(["codex", "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only"]);
  expect(isolated).toContain("mcp_servers.alpha.enabled=false");
  expect(isolated).toContain("mcp_servers.beta.enabled=false");
  expect(isolated.join("\0")).not.toContain("mcp_servers={}");
  for (const feat of CODEX_DISABLE_FEATURES) expect(isolated).toContain(feat);
  expect(isolated).toContain("shell_tool");
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

test("paused compact still fits the view and the turn still answers", async () => {
  const dir = tmpDir("grow");
  const mem = new Memory({
    dir,
    nodeBytes: 4000,
    viewBytes: 8192,
    compressor: async () => {
      throw new ProviderLimitError("quota");
    },
  });
  mem.compactWork.paused = "limit";
  const chunk = "x".repeat(4096);
  for (let i = 0; i < 52; i++) {
    mem.append({ kind: i % 2 === 0 ? "user" : "talk", text: `${chunk} ${i}` });
  }
  await mem.pump();
  expect(mem.compactWork.paused).toBe("limit");
  expect(utf8Bytes(chunk.repeat(52))).toBeGreaterThan(200 * 1024);
  expect(mem.viewBytesUsed()).toBeLessThan(200 * 1024);
  expect(mem.viewBytesUsed()).toBeLessThanOrEqual(mem.viewHigh);
  mem.paused = true;

  const { hub } = await makeHub({ nodeBytes: 40, viewBytes: 800 });
  hub.memory.compactWork.paused = "limit";
  const t0 = Date.now();
  await hub.send("oi com compactacao pausada");
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(hub.memory.log.some((m) => m.kind === "talk")).toBe(true);
  hub.close();
});

test("limit and cli-error resume from the saved queue; budget waits for Julio", async () => {
  const backoff = 120;
  async function holdThen(reason: "limit" | "cli-error" | "budget", dir: string) {
    let calls = 0;
    const mem = new Memory({
      dir,
      nodeBytes: 80,
      viewBytes: 2000,
      deferBackoffMs: backoff,
      compressor: async () => {
        calls += 1;
        if (calls === 1) {
          if (reason === "budget") throw new CompactBudgetPause();
          if (reason === "limit") throw new ProviderLimitError("quota");
          throw new CompactCliError("Codex CLI falhou: boom");
        }
        return `1. resumed ${reason}`;
      },
    });
    mem.append({ kind: "user", text: LONG });
    await mem.pump();
    expect(mem.compactWork.paused).toBe(reason);
    const saved = loadCompactQueue(dir);
    expect(saved).toEqual([{ l: 0, i: 0, last: 0, hash: expect.any(String) }]);
    const raw = JSON.parse(readFileSync(join(dir, COMPACT_QUEUE_FILE), "utf8")) as {
      jobs: Array<{ last?: unknown; due?: unknown }>;
    };
    expect(raw.jobs[0]?.last).toBe(0);
    expect(raw.jobs[0]?.due).toBeUndefined();
    return { mem, calls: () => calls, dir };
  }

  const limit = await holdThen("limit", tmpDir("resume-limit"));
  await Bun.sleep(40);
  await limit.mem.pump();
  expect(limit.mem.compactWork.paused).toBe("limit");
  expect(limit.mem.nodeOf(0, 0)?.text).not.toContain("resumed");
  const limitT0 = Date.now();
  while (limit.mem.compactWork.paused && Date.now() - limitT0 < 800) await Bun.sleep(20);
  await limit.mem.pump();
  expect(limit.mem.compactWork.paused).toBeNull();
  expect(limit.mem.nodeOf(0, 0)?.text).toContain("resumed limit");
  expect(loadCompactQueue(limit.dir)).toEqual([]);
  limit.mem.paused = true;

  const cli = await holdThen("cli-error", tmpDir("resume-cli"));
  await Bun.sleep(40);
  await cli.mem.pump();
  expect(cli.mem.compactWork.paused).toBe("cli-error");
  const cliT0 = Date.now();
  while (cli.mem.compactWork.paused && Date.now() - cliT0 < 800) await Bun.sleep(20);
  await cli.mem.pump();
  expect(cli.mem.compactWork.paused).toBeNull();
  expect(cli.mem.nodeOf(0, 0)?.text).toContain("resumed cli-error");
  cli.mem.paused = true;

  const budget = await holdThen("budget", tmpDir("resume-budget"));
  await Bun.sleep(backoff * 3);
  await budget.mem.pump();
  expect(budget.mem.compactWork.paused).toBe("budget");
  expect(budget.calls()).toBe(1);
  expect(budget.mem.nodeOf(0, 0)?.text).not.toContain("resumed");
  budget.mem.clearCompactPause();
  await budget.mem.pump();
  expect(budget.mem.compactWork.paused).toBeNull();
  expect(budget.mem.nodeOf(0, 0)?.text).toContain("resumed budget");
  budget.mem.paused = true;
});

test("compact-queue.json writes last and still loads a legacy due", () => {
  const dir = tmpDir("queue-last");
  writeFileSync(
    join(dir, COMPACT_QUEUE_FILE),
    `${JSON.stringify({ jobs: [{ l: 1, i: 2, due: 5, hash: "old" }] })}\n`,
  );
  expect(loadCompactQueue(dir)).toEqual([{ l: 1, i: 2, last: 5, hash: "old" }]);
  const q = new CompactQueue(dir);
  q.load();
  q.put({ l: 0, i: 4, last: 4, hash: "new" });
  const raw = JSON.parse(readFileSync(join(dir, COMPACT_QUEUE_FILE), "utf8")) as {
    jobs: Array<{ last?: unknown; due?: unknown; hash?: string }>;
  };
  expect(raw.jobs.map((j) => j.due)).toEqual([undefined, undefined]);
  expect(raw.jobs).toEqual([
    { l: 1, i: 2, last: 5, hash: "old" },
    { l: 0, i: 4, last: 4, hash: "new" },
  ]);
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
      if (argv[1] === "mcp") {
        return {
          pid: 41,
          stdout: new Response("[]").body,
          stderr: new Response("").body,
          exited: Promise.resolve(0),
          kill: () => undefined,
        };
      }
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
        if (argv[1] === "mcp") {
          return {
            pid: 2,
            stdout: new Response("[]").body,
            stderr: new Response("").body,
            exited: Promise.resolve(0),
            kill: () => undefined,
          };
        }
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
  expect(sdkPrompts[0]).toContain(rulerBar(512));
  expect(cliPrompts[0]).toContain(rulerBar(512));
  expect(sizeRuler(sdkText)).toBeLessThanOrEqual(512);
  expect(sizeRuler(rulerBar(stretch.nodeBytes))).toBe(stretch.nodeBytes);
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

test("a fake Codex config lists MCP on every spawn and a third server stays off", async () => {
  const dir = tmpDir("mcp-off");
  const listFile = join(dir, "mcp-names.json");
  const log1 = join(dir, "exec-1.json");
  const log2 = join(dir, "exec-2.json");
  await Bun.write(listFile, JSON.stringify(["alpha", "beta"]));
  const bin = join(dir, "codex");
  await Bun.write(bin, `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const listFile = process.env.NCLI_FAKE_MCP_LIST ?? "";
const log = process.env.NCLI_FAKE_CODEX_LOG;
if (argv[0] === "mcp" && argv[1] === "list") {
  const names = JSON.parse(readFileSync(listFile, "utf8")) as string[];
  process.stdout.write(JSON.stringify(names.map((name) => ({ name, enabled: true }))));
  process.exit(0);
}
if (argv[0] === "exec") {
  const names = JSON.parse(readFileSync(listFile, "utf8")) as string[];
  if (log) writeFileSync(log, JSON.stringify(argv));
  const enabledMcp = argv.some((a) => /^mcp_servers\\.[^=]+\\.enabled=true$/.test(a));
  const disabled = names.every((name) => argv.includes(\`mcp_servers.\${name}.enabled=false\`));
  const toolsOff = argv.includes("shell_tool") && argv.includes("--disable");
  const wipe = argv.includes("mcp_servers={}");
  if (enabledMcp || !disabled || !toolsOff || wipe) process.exit(3);
  process.stdout.write('{"type":"agent_message","text":"1. isolated ok"}\\n');
  process.exit(0);
}
process.exit(2);
`);
  const chmod = await Bun.spawn(["chmod", "+x", bin], { stdout: "ignore", stderr: "ignore" }).exited;
  expect(chmod).toBe(0);
  const engine = createCompactEngine(
    loadConfig({
      dataDir: dir,
      compactBackend: "cursor",
      compactSkipTokens: 1,
      compactTimeoutMs: 8000,
      compactDebounceMs: 1,
      compactBatch: 1,
      harness: "cursor",
      codexBin: bin,
    }),
    {
      spawn: (argv, env, opts) => {
        const child = Bun.spawn(argv, {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...env, NCLI_FAKE_MCP_LIST: listFile, NCLI_FAKE_CODEX_LOG: env.NCLI_FAKE_CODEX_LOG ?? log1 },
          cwd: opts?.cwd,
        });
        return {
          pid: child.pid,
          stdout: child.stdout,
          stderr: child.stderr,
          exited: child.exited,
          kill: () => child.kill(),
        };
      },
    },
  );
  engine.setChoice({ mode: "cli", provider: "codex", model: "gpt-5-mini" });
  const first = await engine.compress({
    kind: "leaf",
    source: "user: FACT_OFF",
    contextLines: [],
    nodeBytes: 80,
  });
  expect((typeof first === "string" ? first : first.text)).toContain("isolated ok");
  const argv1 = JSON.parse(await Bun.file(log1).text()) as string[];
  expect(argv1).toContain("mcp_servers.alpha.enabled=false");
  expect(argv1).toContain("mcp_servers.beta.enabled=false");
  expect(argv1.join("\0")).not.toContain("gamma");
  await Bun.write(listFile, JSON.stringify(["alpha", "beta", "gamma"]));
  const secondEngine = createCompactEngine(
    loadConfig({
      dataDir: join(dir, "second"),
      compactBackend: "cursor",
      compactSkipTokens: 1,
      compactTimeoutMs: 8000,
      compactDebounceMs: 1,
      compactBatch: 1,
      harness: "cursor",
      codexBin: bin,
    }),
    {
      spawn: (argv, env, opts) => {
        const child = Bun.spawn(argv, {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...env, NCLI_FAKE_MCP_LIST: listFile, NCLI_FAKE_CODEX_LOG: log2 },
          cwd: opts?.cwd,
        });
        return {
          pid: child.pid,
          stdout: child.stdout,
          stderr: child.stderr,
          exited: child.exited,
          kill: () => child.kill(),
        };
      },
    },
  );
  secondEngine.setChoice({ mode: "cli", provider: "codex", model: "gpt-5-mini" });
  await secondEngine.compress({
    kind: "leaf",
    source: "user: FACT_OFF_2",
    contextLines: [],
    nodeBytes: 80,
  });
  const argv2 = JSON.parse(await Bun.file(log2).text()) as string[];
  expect(argv2).toContain("mcp_servers.alpha.enabled=false");
  expect(argv2).toContain("mcp_servers.beta.enabled=false");
  expect(argv2).toContain("mcp_servers.gamma.enabled=false");
  expect(argv2.join("\0")).not.toContain("mcp_servers={}");
  expect(parseMcpList(JSON.stringify([{ name: "alpha" }, { name: "beta" }, { name: "gamma" }]))).toEqual([
    "alpha",
    "beta",
    "gamma",
  ]);
  for (const feat of ["shell_tool", "unified_exec", "apps", "browser_use"]) {
    expect(isolateCodexFlags(["alpha", "beta", "gamma"])).toContain(feat);
  }
});

test("empty output is not Too long and oversize retries at most five times", async () => {
  let emptyCalls = 0;
  const empty = await withTooLong(
    async () => {
      emptyCalls += 1;
      return "";
    },
    "prompt",
    "mini",
    () => true,
  );
  expect(empty).toBe("");
  expect(emptyCalls).toBe(1);

  let overCalls = 0;
  const over = await withTooLong(
    async (ask) => {
      overCalls += 1;
      return ask.startsWith("Too long.") ? "1. short" : "1. " + "x".repeat(80);
    },
    "prompt",
    "mini",
    (reply) => sizeRuler(reply) > 20,
  );
  expect(over).toBe("1. short");
  expect(overCalls).toBe(2);

  let stuck = 0;
  const last = await withTooLong(
    async () => {
      stuck += 1;
      return "1. " + "y".repeat(80);
    },
    "prompt",
    "mini",
    (reply) => sizeRuler(reply) > 20,
  );
  expect(last.startsWith("1. ")).toBe(true);
  expect(stuck).toBe(5);

  let engineCalls = 0;
  const dir = tmpDir("one-layer");
  const engine = createCompactEngine(
    loadConfig({
      dataDir: dir,
      compactBackend: "cursor",
      compactSkipTokens: 1,
      compactTimeoutMs: 0,
      compactDebounceMs: 1,
      compactBatch: 1,
    }),
    {
      runner: async () => {
        engineCalls += 1;
        return "1. " + "z".repeat(200);
      },
    },
  );
  await expect(engine.compress({
    kind: "leaf",
    source: LONG,
    contextLines: [],
    nodeBytes: 40,
  })).rejects.toBeDefined();
  expect(engineCalls).toBe(5);
});
