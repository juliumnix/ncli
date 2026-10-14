import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planCodexSession } from "../src/acp/codex";
import { DEFAULT_SESSION_CAP } from "../src/acp/session";
import { tmpDir } from "./helpers";

const NOISE = 20000;

test("planCodexSession resumes a cached rollout in under 20ms and rotates when that file grows", () => {
  const dataDir = tmpDir("codex-stat");
  const sessions = tmpDir("codex-stat-sess");
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  const threadId = "thread-tiny";
  for (let i = 0; i < NOISE; i++) writeFileSync(join(sessions, `noise-${i}.jsonl`), "n");
  const rollout = join(sessions, "rollout-thread-tiny.jsonl");
  writeFileSync(rollout, "tiny");
  writeFileSync(join(dataDir, "sessions", "main.codex.id"), threadId, "utf8");

  const first = planCodexSession({ dataDir, name: "main", sessionsDir: sessions });
  expect(first).toEqual({ id: threadId, resume: true, rotated: false });

  const started = performance.now();
  const second = planCodexSession({ dataDir, name: "main", sessionsDir: sessions });
  const elapsed = performance.now() - started;
  expect(second).toEqual({ id: threadId, resume: true, rotated: false });
  expect(elapsed).toBeLessThan(20);

  const blob = JSON.parse(readFileSync(join(dataDir, "sessions", "main.codex.blob"), "utf8")) as {
    id: string;
    path: string;
    bytes: number;
  };
  expect(blob.id).toBe(threadId);
  expect(blob.path.endsWith("rollout-thread-tiny.jsonl")).toBe(true);
  expect(blob.bytes).toBe(4);

  writeFileSync(rollout, "x".repeat(DEFAULT_SESSION_CAP + 10));
  const fat = planCodexSession({
    dataDir,
    name: "main",
    sessionsDir: sessions,
    capBytes: DEFAULT_SESSION_CAP,
  });
  expect(fat).toEqual({ id: "", resume: false, rotated: true });

  rmSync(rollout);
  const moved = join(sessions, "other-thread-tiny.jsonl");
  writeFileSync(moved, "tiny");
  const walked = planCodexSession({ dataDir, name: "main", sessionsDir: sessions });
  expect(walked).toEqual({ id: threadId, resume: true, rotated: false });
  const refreshed = JSON.parse(readFileSync(join(dataDir, "sessions", "main.codex.blob"), "utf8")) as {
    path: string;
  };
  expect(refreshed.path.endsWith("other-thread-tiny.jsonl")).toBe(true);
});
