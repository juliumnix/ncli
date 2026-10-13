import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCliAdapter } from "../src/acp/claude";
import { CodexExecAdapter } from "../src/acp/codex";
import { CursorAcpAdapter } from "../src/acp/cursor";
import { loadConfig } from "../src/config";
import { tmpDir } from "./helpers";

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

function spawnLines(logPath: string): Array<{ pid?: number; argv?: string[]; method?: string }> {
  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as { pid?: number; argv?: string[]; method?: string });
}

function processSpawns(logPath: string): Array<{ pid: number; argv: string[] }> {
  return spawnLines(logPath).flatMap((rec) =>
    typeof rec.pid === "number" && !rec.method && rec.argv ? [{ pid: rec.pid, argv: rec.argv }] : [],
  );
}

test("claude keeps one hot process per session and never hands a spark the chat process", async () => {
  const dataDir = tmpDir("hot-iso-claude");
  const chatSkills = join(dataDir, "chat-skills");
  const sparkSkills = join(dataDir, "spark-skills");
  mkdirSync(chatSkills);
  mkdirSync(sparkSkills);
  const logPath = join(dataDir, "spawn.jsonl");
  const prev = process.env.FAKE_CLAUDE_LOG;
  process.env.FAKE_CLAUDE_LOG = logPath;
  const cfg = loadConfig({ dataDir, claudeBin: chmodFake(FAKE_CLAUDE), repo: dataDir, claudeModel: "" });
  const adapter = new ClaudeCliAdapter(cfg);
  try {
    const chat = collect(adapter.run({ prompt: "chat", session: "main", cwd: chatSkills, addDir: [chatSkills] }));
    const spark = collect(
      adapter.run({ prompt: "spark", session: "spark-1", cwd: sparkSkills, addDir: [sparkSkills] }),
    );
    const [chatEvents, sparkEvents] = await Promise.all([chat, spark]);
    expect(chatEvents.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(sparkEvents.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(true);
    const spawns = processSpawns(logPath);
    expect(spawns.filter((s) => s.argv.includes(chatSkills)).map((s) => s.pid)).toEqual([spawns[0]!.pid]);
    expect(spawns.filter((s) => s.argv.includes(sparkSkills)).map((s) => s.pid)).toEqual([spawns[1]!.pid]);
    expect(new Set(spawns.map((s) => s.pid)).size).toBe(2);
    const after = spawns.length;
    const again = await collect(adapter.run({ prompt: "chat-2", session: "main", cwd: chatSkills, addDir: [chatSkills] }));
    expect(again.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(adapter.lastTrace?.hot).toBe(true);
    expect(processSpawns(logPath)).toHaveLength(after);
    adapter.release("spark-1");
    await collect(adapter.run({ prompt: "spark-2", session: "spark-1", cwd: sparkSkills, addDir: [sparkSkills] }));
    expect(processSpawns(logPath)).toHaveLength(after + 1);
    await collect(adapter.run({ prompt: "chat-3", session: "main", cwd: chatSkills, addDir: [chatSkills] }));
    expect(adapter.lastTrace?.hot).toBe(true);
    expect(processSpawns(logPath)).toHaveLength(after + 1);
  } finally {
    adapter.close();
    if (prev === undefined) delete process.env.FAKE_CLAUDE_LOG;
    else process.env.FAKE_CLAUDE_LOG = prev;
  }
});

test("codex keeps one waiter per session and passes that session's skill dirs", async () => {
  const dataDir = tmpDir("hot-iso-codex");
  const chatSkills = join(dataDir, "chat-skills");
  const sparkSkills = join(dataDir, "spark-skills");
  mkdirSync(chatSkills);
  mkdirSync(sparkSkills);
  const logPath = join(dataDir, "spawn.jsonl");
  const prev = process.env.FAKE_CODEX_LOG;
  process.env.FAKE_CODEX_LOG = logPath;
  const cfg = loadConfig({ dataDir, codexBin: chmodFake(FAKE_CODEX), repo: dataDir, codexModel: "" });
  const adapter = new CodexExecAdapter(cfg);
  try {
    const chat = collect(adapter.run({ prompt: "chat", session: "main", cwd: chatSkills, addDir: [chatSkills] }));
    const spark = collect(
      adapter.run({ prompt: "spark", session: "spark-1", cwd: sparkSkills, addDir: [sparkSkills] }),
    );
    const [chatEvents, sparkEvents] = await Promise.all([chat, spark]);
    expect(chatEvents.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(sparkEvents.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(true);
    const spawns = processSpawns(logPath);
    expect(spawns.some((s) => s.argv.includes("--add-dir") && s.argv.includes(chatSkills) && !s.argv.includes(sparkSkills))).toBe(
      true,
    );
    expect(spawns.some((s) => s.argv.includes("--add-dir") && s.argv.includes(sparkSkills) && !s.argv.includes(chatSkills))).toBe(
      true,
    );
    const again = await collect(adapter.run({ prompt: "chat-2", session: "main", cwd: chatSkills, addDir: [chatSkills] }));
    expect(again.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(adapter.lastTrace?.hot).toBe(true);
    adapter.release("spark-1");
    await collect(adapter.run({ prompt: "spark-2", session: "spark-1", cwd: sparkSkills, addDir: [sparkSkills] }));
    await collect(adapter.run({ prompt: "chat-3", session: "main", cwd: chatSkills, addDir: [chatSkills] }));
    expect(adapter.lastTrace?.hot).toBe(true);
  } finally {
    adapter.close();
    if (prev === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = prev;
  }
});

test("cursor keeps one ACP process per session and sends that session's skill dirs", async () => {
  const dataDir = tmpDir("hot-iso-cursor");
  const chatSkills = join(dataDir, "chat-skills");
  const sparkSkills = join(dataDir, "spark-skills");
  mkdirSync(chatSkills);
  mkdirSync(sparkSkills);
  const logPath = join(dataDir, "spawn.jsonl");
  const prev = process.env.FAKE_CURSOR_LOG;
  process.env.FAKE_CURSOR_LOG = logPath;
  const cfg = loadConfig({
    dataDir,
    acpCursor: `${chmodFake(FAKE_CURSOR)} acp`,
    repo: dataDir,
    cursorModel: "composer-2.5",
  });
  const adapter = new CursorAcpAdapter(cfg);
  try {
    const chat = collect(adapter.run({ prompt: "chat", session: "main", cwd: chatSkills, addDir: [chatSkills] }));
    const spark = collect(
      adapter.run({ prompt: "spark", session: "spark-1", cwd: sparkSkills, addDir: [sparkSkills] }),
    );
    const [chatEvents, sparkEvents] = await Promise.all([chat, spark]);
    expect(chatEvents.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(sparkEvents.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(true);
    const spawns = processSpawns(logPath);
    expect(new Set(spawns.map((s) => s.pid)).size).toBe(2);
    const opened = spawnLines(logPath).filter((rec) => rec.method === "session/new") as Array<{
      cwd?: string;
      addDir?: string[];
    }>;
    expect(opened).toContainEqual(expect.objectContaining({ cwd: chatSkills, addDir: [chatSkills] }));
    expect(opened).toContainEqual(expect.objectContaining({ cwd: sparkSkills, addDir: [sparkSkills] }));
    const after = spawns.length;
    await collect(adapter.run({ prompt: "chat-2", session: "main", cwd: chatSkills, addDir: [chatSkills] }));
    expect(adapter.lastTrace?.hot).toBe(true);
    expect(processSpawns(logPath)).toHaveLength(after);
    adapter.release("spark-1");
    await collect(adapter.run({ prompt: "spark-2", session: "spark-1", cwd: sparkSkills, addDir: [sparkSkills] }));
    expect(processSpawns(logPath)).toHaveLength(after + 1);
    await collect(adapter.run({ prompt: "chat-3", session: "main", cwd: chatSkills, addDir: [chatSkills] }));
    expect(adapter.lastTrace?.hot).toBe(true);
    expect(processSpawns(logPath)).toHaveLength(after + 1);
  } finally {
    adapter.close();
    if (prev === undefined) delete process.env.FAKE_CURSOR_LOG;
    else process.env.FAKE_CURSOR_LOG = prev;
  }
});
