import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexExecAdapter } from "../src/acp/codex";
import { loadConfig } from "../src/config";
import { tmpDir } from "./helpers";

const FAKE_CODEX = join(import.meta.dir, "fixtures/fake-codex");

test("a finished codex turn does not leave a resume process", async () => {
  const dataDir = tmpDir("codex-linger");
  const logPath = join(dataDir, "codex.log");
  const prev = process.env.FAKE_CODEX_LOG;
  process.env.FAKE_CODEX_LOG = logPath;
  chmodSync(FAKE_CODEX, 0o755);
  const adapter = new CodexExecAdapter(loadConfig({ dataDir, repo: dataDir, codexBin: FAKE_CODEX }));
  try {
    const events = [];
    for await (const ev of adapter.run({ prompt: "one", session: "main", cwd: dataDir })) events.push(ev);
    expect(events.some((ev) => ev.sessionUpdate === "agent_message_chunk")).toBe(true);
    const alive = await lingerPids(logPath);
    expect(alive).toEqual([]);
    for await (const _ev of adapter.run({ prompt: "two", session: "main", cwd: dataDir })) void _ev;
    for await (const _ev of adapter.run({ prompt: "three", session: "main", cwd: dataDir })) void _ev;
    expect(await lingerPids(logPath)).toEqual([]);
  } finally {
    adapter.close();
    if (prev === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = prev;
  }
});

async function lingerPids(logPath: string): Promise<number[]> {
  const start = Date.now();
  let alive: number[] = [];
  while (Date.now() - start < 2000) {
    const pids = readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { pid?: number }).pid)
      .filter((pid): pid is number => typeof pid === "number");
    alive = [...new Set(pids)].filter((pid) => existsSync(`/proc/${pid}`));
    if (alive.length === 0) return [];
    await Bun.sleep(50);
  }
  return alive;
}
