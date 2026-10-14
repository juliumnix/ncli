import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCliAdapter, formatClaudeTrace } from "../src/acp/claude";
import {
  buildCodexArgs,
  CodexExecAdapter,
  codexStdinPrompt,
  planCodexSession,
} from "../src/acp/codex";
import { CursorAcpAdapter } from "../src/acp/cursor";
import {
  DEFAULT_SESSION_CAP,
  persistSeatModel,
  readSeatId,
  readSeatModel,
} from "../src/acp/session";
import { loadConfig } from "../src/config";
import { AcpHarness } from "../src/harness/acp";
import { Hub } from "../src/hub";
import { shotsDir, tmpDir } from "./helpers";

const FAKE_CLAUDE = join(import.meta.dir, "fixtures/fake-claude");
const FAKE_CODEX = join(import.meta.dir, "fixtures/fake-codex");
const FAKE_CURSOR = join(import.meta.dir, "fixtures/fake-cursor");

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

function chmodFake(path: string): string {
  chmodSync(path, 0o755);
  return path;
}

type Row = { seat: string; path: string; initMs: number; tokenMs: number };

function rowOf(
  seat: string,
  path: string,
  spawnAt: number,
  turnAt: number,
  initAt: number | undefined,
  tokenAt: number | undefined,
  hot: boolean,
): Row {
  const origin = hot ? turnAt : spawnAt;
  return {
    seat,
    path,
    initMs: Math.round((initAt ?? origin) - origin),
    tokenMs: Math.round((tokenAt ?? origin) - origin),
  };
}

test("codex exec reads the prompt from stdin dash and resumes a small thread", () => {
  const dataDir = tmpDir("codex-args");
  const cfg = loadConfig({ dataDir, codexBin: "codex" });
  const args = buildCodexArgs(cfg, { prompt: "confirma" });
  expect(args.slice(0, 4)).toEqual(["codex", "exec", "--json", "--skip-git-repo-check"]);
  expect(args.at(-1)).toBe("-");
  expect(args).not.toContain("confirma");
  expect(codexStdinPrompt({ prompt: "confirma", system: "You are NCLI." })).toContain("You are NCLI.");
  expect(codexStdinPrompt({ prompt: "confirma", system: "You are NCLI." })).toContain("confirma");
  const pinned = loadConfig({ dataDir, codexBin: "codex", codexModel: "gpt-6.1-sol" });
  expect(buildCodexArgs(pinned, { prompt: "confirma" }).slice(0, 6)).toEqual([
    "codex",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--model",
    "gpt-6.1-sol",
  ]);
});

test("planCodexSession rotates a fat rollout jsonl and resumes a small one", () => {
  const dataDir = tmpDir("plan-codex");
  const sessions = tmpDir("codex-sess");
  const first = planCodexSession({ dataDir, name: "main", sessionsDir: sessions });
  expect(first.resume).toBe(false);
  expect(first.rotated).toBe(false);
  writeFileSync(join(dataDir, "sessions", "main.codex.id"), "thread-fat", "utf8");
  writeFileSync(join(sessions, "rollout-thread-fat.jsonl"), "x".repeat(DEFAULT_SESSION_CAP + 10));
  const rotated = planCodexSession({
    dataDir,
    name: "main",
    sessionsDir: sessions,
    capBytes: DEFAULT_SESSION_CAP,
  });
  expect(rotated.rotated).toBe(true);
  expect(rotated.resume).toBe(false);
  writeFileSync(join(dataDir, "sessions", "main.codex.id"), "thread-tiny", "utf8");
  writeFileSync(join(sessions, "rollout-thread-tiny.jsonl"), "tiny");
  const small = planCodexSession({ dataDir, name: "main", sessionsDir: sessions });
  expect(small.resume).toBe(true);
  expect(small.rotated).toBe(false);
  expect(small.id).toBe("thread-tiny");
});

test("codex resumes the saved thread on a fresh process", async () => {
  const dataDir = tmpDir("hot-codex");
  const logPath = join(dataDir, "spawn.jsonl");
  const prev = process.env.FAKE_CODEX_LOG;
  process.env.FAKE_CODEX_LOG = logPath;
  process.env.FAKE_CODEX_MODEL = "gpt-5.4";
  const cfg = loadConfig({ dataDir, codexBin: chmodFake(FAKE_CODEX), repo: dataDir, codexModel: "" });
  const adapter = new CodexExecAdapter(cfg);
  try {
    const first = await collect(adapter.run({ prompt: "oi", session: "main", cwd: dataDir }));
    expect(first).toContainEqual({ sessionUpdate: "model", model: "gpt-5.4" });
    expect(first.some((e) => e.sessionUpdate === "agent_message_chunk" && "text" in e && e.text === "oi")).toBe(true);
    expect(adapter.lastTrace?.hot).toBe(false);
    expect(adapter.lastTrace?.initAt).toBeGreaterThan(adapter.lastTrace!.spawnAt);
    expect(adapter.lastTrace?.firstTokenAt).toBeGreaterThan(adapter.lastTrace!.initAt!);
    expect(readSeatModel(dataDir, "main", "codex")).toBe("gpt-5.4");
    expect(readSeatId(dataDir, "main", "codex")).toBeTruthy();

    const second = await collect(adapter.run({ prompt: "de novo", session: "main", cwd: dataDir }));
    expect(second.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(adapter.lastTrace?.hot).toBe(false);
    const spawns = readFileSync(logPath, "utf8").trim().split("\n");
    expect(spawns.length).toBeGreaterThanOrEqual(2);
    const resumed = spawns.some((line) => JSON.parse(line).argv?.includes("resume"));
    expect(resumed).toBe(true);
  } finally {
    adapter.close();
    if (prev === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = prev;
    delete process.env.FAKE_CODEX_MODEL;
  }
});

test("a hot cursor ACP process handles two prompts with one spawn and timestamps init then token", async () => {
  const dataDir = tmpDir("hot-cursor");
  const logPath = join(dataDir, "spawn.jsonl");
  const prev = process.env.FAKE_CURSOR_LOG;
  process.env.FAKE_CURSOR_LOG = logPath;
  process.env.FAKE_CURSOR_MODEL = "composer-2.5";
  const cfg = loadConfig({
    dataDir,
    acpCursor: `${chmodFake(FAKE_CURSOR)} acp`,
    repo: dataDir,
    cursorModel: "composer-2.5",
  });
  const adapter = new CursorAcpAdapter(cfg);
  try {
    const first = await collect(adapter.run({ prompt: "oi", session: "main", cwd: dataDir }));
    expect(first).toContainEqual({ sessionUpdate: "model", model: "composer-2.5" });
    expect(first.some((e) => e.sessionUpdate === "agent_message_chunk" && "text" in e && e.text === "oi")).toBe(true);
    expect(adapter.lastTrace?.hot).toBe(false);
    expect(adapter.lastTrace?.initAt).toBeGreaterThan(adapter.lastTrace!.spawnAt);
    expect(adapter.lastTrace?.firstTokenAt).toBeGreaterThan(adapter.lastTrace!.initAt!);
    expect(readSeatModel(dataDir, "main", "cursor")).toBe("composer-2.5");
    expect(readSeatId(dataDir, "main", "cursor")).toBeTruthy();

    const second = await collect(adapter.run({ prompt: "de novo", session: "main", cwd: dataDir }));
    expect(second.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(adapter.lastTrace?.hot).toBe(true);
    const spawns = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => {
        const rec = JSON.parse(line) as { pid?: number; method?: string };
        return typeof rec.pid === "number" && !rec.method;
      });
    expect(spawns).toHaveLength(1);
  } finally {
    adapter.close();
    if (prev === undefined) delete process.env.FAKE_CURSOR_LOG;
    else process.env.FAKE_CURSOR_LOG = prev;
    delete process.env.FAKE_CURSOR_MODEL;
  }
});

test("cursor rotates a fat session with a new session/new on the same process", async () => {
  const dataDir = tmpDir("rot-cursor");
  const logPath = join(dataDir, "spawn.jsonl");
  const prevLog = process.env.FAKE_CURSOR_LOG;
  const prevCap = process.env.NCLI_CURSOR_SESSION_CAP;
  process.env.FAKE_CURSOR_LOG = logPath;
  process.env.NCLI_CURSOR_SESSION_CAP = "8";
  const cfg = loadConfig({
    dataDir,
    acpCursor: `${chmodFake(FAKE_CURSOR)} acp`,
    repo: dataDir,
  });
  const adapter = new CursorAcpAdapter(cfg);
  try {
    await collect(adapter.run({ prompt: "twelve chars!!", session: "main", cwd: dataDir }));
    const firstId = readSeatId(dataDir, "main", "cursor");
    await collect(adapter.run({ prompt: "again", session: "main", cwd: dataDir }));
    const secondId = readSeatId(dataDir, "main", "cursor");
    expect(secondId).not.toBe(firstId);
    expect(adapter.lastTrace?.rotated).toBe(true);
    expect(adapter.lastTrace?.hot).toBe(true);
    const news = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => (JSON.parse(line) as { method?: string }).method === "session/new");
    expect(news.length).toBeGreaterThanOrEqual(2);
    const spawns = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => typeof (JSON.parse(line) as { pid?: number }).pid === "number" && !(JSON.parse(line) as { method?: string }).method);
    expect(spawns).toHaveLength(1);
  } finally {
    adapter.close();
    if (prevLog === undefined) delete process.env.FAKE_CURSOR_LOG;
    else process.env.FAKE_CURSOR_LOG = prevLog;
    if (prevCap === undefined) delete process.env.NCLI_CURSOR_SESSION_CAP;
    else process.env.NCLI_CURSOR_SESSION_CAP = prevCap;
  }
});

test("AcpHarness through fake Codex and Cursor yields model then text", async () => {
  const dataDir = tmpDir("hot-acp-seats");
  const codex = new CodexExecAdapter(
    loadConfig({ dataDir, codexBin: chmodFake(FAKE_CODEX), repo: dataDir, codexModel: "gpt-5.4" }),
  );
  const cursor = new CursorAcpAdapter(
    loadConfig({ dataDir, acpCursor: `${chmodFake(FAKE_CURSOR)} acp`, repo: dataDir, cursorModel: "composer-2.5" }),
  );
  try {
    const cx = await collect(new AcpHarness(codex).run({ prompt: "oi", session: "main", cwd: dataDir }));
    expect(cx).toContainEqual({ type: "model", model: "gpt-5.4", seat: "codex" });
    expect(cx.some((e) => e.type === "text" && e.text === "oi")).toBe(true);
    const cr = await collect(new AcpHarness(cursor).run({ prompt: "oi", session: "main", cwd: dataDir }));
    expect(cr).toContainEqual({ type: "model", model: "composer-2.5", seat: "cursor" });
    expect(cr.some((e) => e.type === "text" && e.text === "oi")).toBe(true);
  } finally {
    codex.close();
    cursor.close();
  }
});

test("persistSeatModel round-trips Claude, Codex, and Cursor", () => {
  const dataDir = tmpDir("seat-model");
  persistSeatModel(dataDir, "main", "claude", "claude-opus-4-5");
  persistSeatModel(dataDir, "main", "codex", "gpt-5.4");
  persistSeatModel(dataDir, "main", "cursor", "composer-2.5");
  expect(readSeatModel(dataDir, "main", "claude")).toBe("claude-opus-4-5");
  expect(readSeatModel(dataDir, "main", "codex")).toBe("gpt-5.4");
  expect(readSeatModel(dataDir, "main", "cursor")).toBe("composer-2.5");
});

test("hub reads the persisted Codex and Cursor models into the header", () => {
  const dataDir = tmpDir("seat-header");
  persistSeatModel(dataDir, "main", "codex", "gpt-5.4");
  persistSeatModel(dataDir, "main", "cursor", "composer-2-fast");
  const views = join(import.meta.dir, "../views");
  const fixtures = join(import.meta.dir, "../fixtures/gh");
  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmpDir("empty-codex");
  const adapter = new CodexExecAdapter(loadConfig({ dataDir, repo: dataDir, codexBin: chmodFake(FAKE_CODEX) }));
  const codexHub = new Hub(
    loadConfig({ dataDir, repo: dataDir, ncliRoot: join(import.meta.dir, ".."), harness: "codex", ghMode: "mock" }),
    views,
    fixtures,
    new AcpHarness(adapter),
  );
  expect(codexHub.mainAgent()).toEqual({ harness: "codex", model: "gpt-5.4" });
  codexHub.close();
  if (prevHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevHome;
  const cursorCfg = loadConfig({
    dataDir,
    repo: dataDir,
    ncliRoot: join(import.meta.dir, ".."),
    harness: "cursor",
    cursorModel: "composer-2-fast",
    ghMode: "mock",
  });
  const cursorHub = new Hub(cursorCfg, views, fixtures, new AcpHarness(new CursorAcpAdapter(cursorCfg)));
  expect(cursorHub.mainAgent()).toEqual({ harness: "cursor", model: "composer-2-fast" });
  cursorHub.close();
});

test("NCLI hot second token beats a cold spawn for Claude, Codex, and Cursor", async () => {
  const dataDir = tmpDir("trio-ttft");
  const rows: Row[] = [];
  chmodFake(FAKE_CLAUDE);
  chmodFake(FAKE_CODEX);
  chmodFake(FAKE_CURSOR);

  const claude = new ClaudeCliAdapter(loadConfig({ dataDir, claudeBin: FAKE_CLAUDE, repo: dataDir }));
  try {
    await collect(claude.run({ prompt: "oi", session: "main", cwd: dataDir }));
    const cold = claude.lastTrace!;
    rows.push(rowOf("claude", "before (cold spawn each turn)", cold.spawnAt, cold.turnAt, cold.initAt, cold.firstTokenAt, false));
    await collect(claude.run({ prompt: "oi", session: "main", cwd: dataDir }));
    const hot = claude.lastTrace!;
    rows.push(rowOf("claude", "after (hot process)", hot.spawnAt, hot.turnAt, hot.initAt, hot.firstTokenAt, true));
    expect(hot.hot).toBe(true);
    expect(formatClaudeTrace(hot)).toContain("hot");
  } finally {
    claude.close();
  }

  const tClaude = performance.now();
  const pClaude = Bun.spawn([FAKE_CLAUDE, "-p", "--output-format", "stream-json", "--verbose"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  await new Response(pClaude.stdout).text();
  await pClaude.exited;
  const claudeCli = Math.round(performance.now() - tClaude);
  rows.push({ seat: "claude", path: "fake CLI cold -p", initMs: claudeCli, tokenMs: claudeCli });

  const codex = new CodexExecAdapter(loadConfig({ dataDir, codexBin: FAKE_CODEX, repo: dataDir }));
  try {
    await collect(codex.run({ prompt: "oi", session: "main", cwd: dataDir }));
    const cold = codex.lastTrace!;
    rows.push(rowOf("codex", "before (cold spawn each turn)", cold.spawnAt, cold.turnAt, cold.initAt, cold.firstTokenAt, false));
    await Bun.sleep(120);
    await collect(codex.run({ prompt: "oi", session: "main", cwd: dataDir }));
    const hot = codex.lastTrace!;
    rows.push(rowOf("codex", "after (cold resume)", hot.spawnAt, hot.turnAt, hot.initAt, hot.firstTokenAt, false));
    expect(hot.hot).toBe(false);
  } finally {
    codex.close();
  }

  const tCodex = performance.now();
  const pCodex = Bun.spawn([FAKE_CODEX, "exec", "--json", "oi"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  await new Response(pCodex.stdout).text();
  await pCodex.exited;
  const codexCli = Math.round(performance.now() - tCodex);
  rows.push({ seat: "codex", path: "fake CLI cold exec --json", initMs: codexCli, tokenMs: codexCli });

  const cursor = new CursorAcpAdapter(
    loadConfig({ dataDir, acpCursor: `${FAKE_CURSOR} acp`, repo: dataDir, cursorModel: "composer-2.5" }),
  );
  try {
    await collect(cursor.run({ prompt: "oi", session: "main", cwd: dataDir }));
    const cold = cursor.lastTrace!;
    rows.push(rowOf("cursor", "before (cold spawn each turn)", cold.spawnAt, cold.turnAt, cold.initAt, cold.firstTokenAt, false));
    await collect(cursor.run({ prompt: "oi", session: "main", cwd: dataDir }));
    const hot = cursor.lastTrace!;
    rows.push(rowOf("cursor", "after (persistent ACP process)", hot.spawnAt, hot.turnAt, hot.initAt, hot.firstTokenAt, true));
    expect(hot.hot).toBe(true);
  } finally {
    cursor.close();
  }

  const tCursor = performance.now();
  const pCursor = Bun.spawn([FAKE_CURSOR, "acp"], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
  const stdin = pCursor.stdin;
  if (stdin && typeof stdin !== "number") {
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: dataDir, mcpServers: [] } })}\n`,
    );
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "x", prompt: [{ type: "text", text: "oi" }] } })}\n`,
    );
    stdin.end();
  }
  await new Response(pCursor.stdout).text();
  await pCursor.exited;
  const cursorCli = Math.round(performance.now() - tCursor);
  rows.push({ seat: "cursor", path: "fake CLI cold acp init+prompt", initMs: cursorCli, tokenMs: cursorCli });

  const afterClaude = rows.find((r) => r.seat === "claude" && r.path.startsWith("after"));
  const beforeClaude = rows.find((r) => r.seat === "claude" && r.path.startsWith("before"));
  const afterCodex = rows.find((r) => r.seat === "codex" && r.path.startsWith("after"));
  const beforeCodex = rows.find((r) => r.seat === "codex" && r.path.startsWith("before"));
  const afterCursor = rows.find((r) => r.seat === "cursor" && r.path.startsWith("after"));
  const beforeCursor = rows.find((r) => r.seat === "cursor" && r.path.startsWith("before"));
  expect(afterClaude!.tokenMs).toBeLessThanOrEqual(beforeClaude!.tokenMs + 50);
  expect(afterCodex!.tokenMs).toBeLessThanOrEqual(beforeCodex!.tokenMs + 50);
  expect(afterCursor!.tokenMs).toBeLessThanOrEqual(beforeCursor!.tokenMs + 50);

  const table = [
    "| seat | path | spawn→init | spawn→token |",
    "| --- | --- | ---: | ---: |",
    ...rows.map((r) => `| ${r.seat} | ${r.path} | ${r.initMs}ms | ${r.tokenMs}ms |`),
  ].join("\n");
  mkdirSync(join(dataDir, "out"), { recursive: true });
  writeFileSync(join(dataDir, "out", "ttft.md"), `${table}\n`);
  const shots = shotsDir();
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, "first-oi-ttft.md"), `${table}\n`);
  expect(table).toContain("claude");
  expect(table).toContain("codex");
  expect(table).toContain("cursor");
  expect(table).toContain("after");
});
