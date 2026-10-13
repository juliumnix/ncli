import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ClaudeCliAdapter,
  DEFAULT_CLAUDE_SESSION_CAP,
  buildClaudeArgs,
  claudeUserLine,
  formatClaudeTrace,
  persistClaudeModel,
  planClaudeSession,
  readClaudeModel,
} from "../src/acp/claude";
import { loadConfig } from "../src/config";
import { AcpHarness } from "../src/harness/acp";
import { shotsDir, tmpDir } from "./helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAKE = join(import.meta.dir, "fixtures/fake-claude");

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

function fakeBin(): string {
  chmodSync(FAKE, 0o755);
  return FAKE;
}

test("planClaudeSession rotates a fat Claude jsonl and resumes a small one", () => {
  const dataDir = tmpDir("plan-sess");
  const projects = tmpDir("plan-proj");
  const first = planClaudeSession({ dataDir, name: "main", projectsDir: projects, cwd: "/tmp/repo" });
  expect(first.id).toMatch(UUID);
  expect(first.resume).toBe(false);
  expect(first.rotated).toBe(false);
  writeFileSync(join(projects, `${first.id}.jsonl`), "x".repeat(DEFAULT_CLAUDE_SESSION_CAP + 10));
  const rotated = planClaudeSession({
    dataDir,
    name: "main",
    projectsDir: projects,
    cwd: "/tmp/repo",
    capBytes: DEFAULT_CLAUDE_SESSION_CAP,
  });
  expect(rotated.rotated).toBe(true);
  expect(rotated.resume).toBe(false);
  expect(rotated.id).not.toBe(first.id);
  writeFileSync(join(projects, `${rotated.id}.jsonl`), "tiny");
  const small = planClaudeSession({ dataDir, name: "main", projectsDir: projects, cwd: "/tmp/repo" });
  expect(small.resume).toBe(true);
  expect(small.rotated).toBe(false);
  expect(small.id).toBe(rotated.id);
});

test("claude user line is stream-json stdin, not an argv prompt", () => {
  const line = claudeUserLine("oi");
  expect(JSON.parse(line)).toEqual({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "oi" }] },
  });
  const cfg = loadConfig({ dataDir: tmpDir("hot-args"), claudeBin: "claude" });
  const args = buildClaudeArgs(cfg, { prompt: "oi", session: "main" });
  expect(args).toContain("--input-format");
  expect(args).toContain("stream-json");
  expect(args).not.toContain("oi");
});

test("a hot claude process handles two turns with one spawn and timestamps init then token", async () => {
  const dataDir = tmpDir("hot-run");
  const logPath = join(dataDir, "spawn.jsonl");
  const prev = process.env.FAKE_CLAUDE_LOG;
  process.env.FAKE_CLAUDE_LOG = logPath;
  process.env.FAKE_CLAUDE_MODEL = "claude-opus-4-5";
  const cfg = loadConfig({ dataDir, claudeBin: fakeBin(), repo: dataDir, claudeModel: "" });
  const adapter = new ClaudeCliAdapter(cfg);
  try {
    const first = await collect(adapter.run({ prompt: "oi", session: "main", cwd: dataDir }));
    expect(first).toContainEqual({ sessionUpdate: "model", model: "claude-opus-4-5" });
    expect(first.some((e) => e.sessionUpdate === "agent_message_chunk" && "text" in e && e.text === "oi")).toBe(true);
    expect(adapter.lastTrace?.hot).toBe(false);
    expect(adapter.lastTrace?.turnAt).toBeGreaterThanOrEqual(adapter.lastTrace!.spawnAt);
    expect(adapter.lastTrace?.initAt).toBeGreaterThan(adapter.lastTrace!.spawnAt);
    expect(adapter.lastTrace?.firstTokenAt).toBeGreaterThan(adapter.lastTrace!.initAt!);
    expect(readClaudeModel(dataDir, "main")).toBe("claude-opus-4-5");
    expect(formatClaudeTrace(adapter.lastTrace!)).toContain("cold");

    const second = await collect(adapter.run({ prompt: "de novo", session: "main", cwd: dataDir }));
    expect(second.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(adapter.lastTrace?.hot).toBe(true);
    expect(formatClaudeTrace(adapter.lastTrace!)).toContain("hot");
    const spawns = readFileSync(logPath, "utf8").trim().split("\n");
    expect(spawns).toHaveLength(1);
  } finally {
    adapter.close();
    if (prev === undefined) delete process.env.FAKE_CLAUDE_LOG;
    else process.env.FAKE_CLAUDE_LOG = prev;
    delete process.env.FAKE_CLAUDE_MODEL;
  }
});

test("NCLI hot second token is faster than a cold spawn of the same fake CLI", async () => {
  const dataDir = tmpDir("hot-ttft");
  const cfg = loadConfig({ dataDir, claudeBin: fakeBin(), repo: dataDir });
  const adapter = new ClaudeCliAdapter(cfg);
  const rows: Array<{ path: string; initMs: number; tokenMs: number }> = [];
  try {
    await collect(adapter.run({ prompt: "oi", session: "main", cwd: dataDir }));
    const cold = adapter.lastTrace!;
    rows.push({
      path: "NCLI first turn (spawn)",
      initMs: Math.round((cold.initAt ?? cold.spawnAt) - cold.spawnAt),
      tokenMs: Math.round((cold.firstTokenAt ?? cold.spawnAt) - cold.spawnAt),
    });
    await collect(adapter.run({ prompt: "oi", session: "main", cwd: dataDir }));
    const hot = adapter.lastTrace!;
    rows.push({
      path: "NCLI second turn (hot)",
      initMs: Math.round((hot.initAt ?? hot.turnAt) - hot.turnAt),
      tokenMs: Math.round((hot.firstTokenAt ?? hot.turnAt) - hot.turnAt),
    });
    const t0 = performance.now();
    const proc = Bun.spawn([fakeBin(), "-p", "--output-format", "stream-json", "--verbose"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const cliMs = Math.round(performance.now() - t0);
    rows.push({ path: "fake CLI cold -p (no stdin)", initMs: cliMs, tokenMs: cliMs });
    expect(out).toContain("system");
    expect(hot.hot).toBe(true);
    expect(rows[1]!.tokenMs).toBeLessThanOrEqual(rows[0]!.tokenMs + 50);
    mkdirSync(join(dataDir, "out"), { recursive: true });
    const table = [
      "| path | spawn→init | spawn→token |",
      "| --- | ---: | ---: |",
      ...rows.map((r) => `| ${r.path} | ${r.initMs}ms | ${r.tokenMs}ms |`),
    ].join("\n");
    writeFileSync(join(dataDir, "out", "ttft.md"), table);
    const shots = shotsDir();
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, "first-oi-ttft.md"), `${table}\n`);
    expect(table).toContain("hot");
  } finally {
    adapter.close();
  }
});

test("AcpHarness through the fake claude yields model then text", async () => {
  const dataDir = tmpDir("hot-acp");
  const cfg = loadConfig({ dataDir, claudeBin: fakeBin(), repo: dataDir });
  const adapter = new ClaudeCliAdapter(cfg);
  const events = await collect(new AcpHarness(adapter).run({ prompt: "oi", session: "main", cwd: dataDir }));
  adapter.close();
  expect(events).toContainEqual({ type: "model", model: "claude-opus-4-5", seat: "claude" });
  expect(events.some((e) => e.type === "text" && e.text === "oi")).toBe(true);
  expect(events.at(-1)).toEqual({ type: "done", text: "oi" });
});

test("persistClaudeModel round-trips the init model", () => {
  const dataDir = tmpDir("hot-model");
  expect(readClaudeModel(dataDir, "main")).toBeUndefined();
  persistClaudeModel(dataDir, "main", "claude-opus-4-5");
  expect(readClaudeModel(dataDir, "main")).toBe("claude-opus-4-5");
});
