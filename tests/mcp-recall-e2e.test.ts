import { expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCliAdapter } from "../src/acp/claude";
import { CodexExecAdapter } from "../src/acp/codex";
import { CursorAcpAdapter } from "../src/acp/cursor";
import { bootNcli } from "../src/boot";
import { loadConfig } from "../src/config";
import { AcpHarness } from "../src/harness/acp";
import { Hub } from "../src/hub";
import { initTempRepo } from "../src/sparks/worktree";
import { tmpDir, waitUntil } from "./helpers";

const FAKE_CLAUDE = join(import.meta.dir, "fixtures/fake-claude");
const FAKE_CODEX = join(import.meta.dir, "fixtures/fake-codex");
const FAKE_CURSOR = join(import.meta.dir, "fixtures/fake-cursor");
const ASK = "você já indexou toda a memória?";

function chmodFake(path: string): string {
  chmodSync(path, 0o755);
  return path;
}

async function seatTalk(kind: "claude" | "codex" | "cursor"): Promise<string> {
  chmodFake(FAKE_CLAUDE);
  chmodFake(FAKE_CODEX);
  chmodFake(FAKE_CURSOR);
  const dataDir = tmpDir(`recall-${kind}`);
  const repo = await initTempRepo();
  const port = 21000 + Math.floor(Math.random() * 800);
  const cfg = loadConfig({
    dataDir,
    repo,
    ncliRoot: join(import.meta.dir, ".."),
    harness: kind,
    claudeBin: FAKE_CLAUDE,
    codexBin: FAKE_CODEX,
    cursorBin: FAKE_CURSOR,
    acpCursor: FAKE_CURSOR,
    compactBackend: "mock",
    ghMode: "mock",
    port,
    importClaude: tmpDir("imp-c"),
    importCodex: tmpDir("imp-x"),
    importCursor: tmpDir("imp-u"),
  });
  const adapter =
    kind === "claude"
      ? new ClaudeCliAdapter(cfg)
      : kind === "codex"
        ? new CodexExecAdapter(cfg)
        : new CursorAcpAdapter(cfg);
  const prevHome = process.env.CODEX_HOME;
  if (kind === "codex") process.env.CODEX_HOME = tmpDir("empty-codex");
  const hub = new Hub(
    cfg,
    tmpDir("no-views"),
    join(import.meta.dir, "../fixtures/gh"),
    new AcpHarness(adapter),
  );
  const booted = await bootNcli({ cfg, hub, root: join(import.meta.dir, "..") });
  hub.memory.append({ kind: "note", text: "Ainda estou trazendo o histórico (42%)." });
  try {
    await hub.send(ASK);
    await waitUntil(
      () => hub.memory.log.some((m) => m.kind === "talk" && /42\s*%/.test(m.text)),
      12000,
      `${kind} recall %`,
    );
    return [...hub.memory.log].reverse().find((m) => m.kind === "talk")?.text ?? "";
  } finally {
    booted.stop();
    hub.close();
    adapter.close?.();
    if (kind === "codex") {
      if (prevHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevHome;
    }
  }
}

test("Claude answers the memory index question from recall, not an approval block", async () => {
  const text = await seatTalk("claude");
  expect(text).toContain("42%");
  expect(text).not.toMatch(/bloqueados|aprovação/i);
});

test("Codex answers the memory index question from recall, not an approval block", async () => {
  const text = await seatTalk("codex");
  expect(text).toContain("42%");
  expect(text).not.toMatch(/bloqueados|aprovação/i);
});

test("Cursor answers the memory index question from recall, not an approval block", async () => {
  const text = await seatTalk("cursor");
  expect(text).toContain("42%");
  expect(text).not.toMatch(/bloqueados|aprovação/i);
});
