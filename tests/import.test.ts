import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alreadyInLog, defaultImportRoots, formatPreview, Importer, parseImportArgv, parseSessionFile } from "../src/import";
import { listSessionFiles } from "../src/import/parse";
import { makeHub, tmpDir } from "./helpers";

const FIX = join(import.meta.dir, "../fixtures/import");
const CLAUDE = join(FIX, "claude/projects");
const CODEX = join(FIX, "codex/sessions");
const CURSOR = join(FIX, "cursor");

test("default roots follow official session dirs and env overrides", () => {
  const home = defaultImportRoots({ HOME: "/home/you" } as NodeJS.ProcessEnv);
  expect(home.claude).toBe(join(homedir(), ".claude", "projects"));
  const over = defaultImportRoots({
    NCLI_IMPORT_CLAUDE: "/tmp/claude-jsonl",
    NCLI_IMPORT_CODEX: "/tmp/codex-jsonl",
    NCLI_IMPORT_CURSOR: "/tmp/cursor-jsonl",
    CLAUDE_CONFIG_DIR: "/tmp/claude-cfg",
    CODEX_HOME: "/tmp/codex-home",
  } as NodeJS.ProcessEnv);
  expect(over.claude).toBe("/tmp/claude-jsonl");
  expect(over.codex).toBe("/tmp/codex-jsonl");
  expect(over.cursor).toBe("/tmp/cursor-jsonl");
  const cfg = defaultImportRoots({
    CLAUDE_CONFIG_DIR: "/tmp/claude-cfg",
    CODEX_HOME: "/tmp/codex-home",
  } as NodeJS.ProcessEnv);
  expect(cfg.claude).toBe("/tmp/claude-cfg/projects");
  expect(cfg.codex).toBe("/tmp/codex-home/sessions");
});

test("parseImportArgv is preview unless --apply", () => {
  expect(parseImportArgv(["claude"])).toEqual({ source: "claude", apply: false, since: undefined, verbose: false });
  expect(parseImportArgv(["codex", "--apply"]).apply).toBe(true);
  expect(parseImportArgv(["cursor", "--since", "2026-10-01"]).since).toBe("2026-10-01T00:00:00.000Z");
  expect(() => parseImportArgv(["gemini"])).toThrow(/uso: \/ncli import/);
  expect(parseImportArgv(["claude", "--verbose"]).verbose).toBe(true);
});

test("preview note omits the root unless verbose", () => {
  const preview = {
    source: "claude" as const,
    root: "/tmp/secret-home/projects",
    sessions: 1,
    lines: [],
    newCount: 4,
    seenCount: 0,
    skipped: 0,
  };
  expect(formatPreview(preview)).not.toContain("/tmp/secret-home");
  expect(formatPreview(preview, true)).toContain("/tmp/secret-home/projects");
});

test("claude JSONL keeps user and talk and drops sidechain system summary", () => {
  const file = join(CLAUDE, "workspace/sess-desconto.jsonl");
  const lines = parseSessionFile("claude", file);
  expect(lines.map((l) => l.kind)).toEqual(["user", "talk", "user", "talk"]);
  expect(lines.map((l) => l.text)).toEqual([
    "como funciona o desconto FACT_MEMBER_DISCOUNT_BEFORE_TAX?",
    "O desconto de membro aplica **antes** do imposto. A ordem é subtotal → desconto → imposto.",
    "e se o cupom vier depois?",
    "Cupom depois do desconto de membro, ainda antes do imposto.",
  ]);
  expect(lines.every((l) => l.source === "claude")).toBe(true);
  expect(lines.some((l) => l.text.includes("sidechain"))).toBe(false);
});

test("codex rollout keeps event_msg and response_item messages", () => {
  const files = listSessionFiles(CODEX, "codex");
  expect(files.length).toBe(1);
  const lines = parseSessionFile("codex", files[0]);
  expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
    "user:ping no Codex: o ask chegou?",
    "talk:pong. O ask chegou e o modelo veio do config.toml.",
    "user:confirma o modelo",
    "talk:gpt-6.1-sol, sem --model na linha.",
  ]);
  expect(lines[0].session).toBe("rollout-aaaa");
});

test("cursor agent-transcripts accept role and type shapes", () => {
  const files = listSessionFiles(CURSOR, "cursor");
  expect(files.length).toBe(2);
  const lines = files.flatMap((f) => parseSessionFile("cursor", f));
  expect(lines.map((l) => l.text)).toEqual([
    "esconde o scrollbar do chat sem quebrar o scroll",
    "Use `scrollbar-width: none` e `::-webkit-scrollbar { display: none }`. O overflow continua.",
    "e o drawer de memória?",
    "Nativo NCLI: fundo escuro, um acento, sem o look do OptMem.",
  ]);
});

test("preview then apply is opt-in and the second apply is empty", async () => {
  const dir = tmpDir("ncli-import-");
  const importer = new Importer(dir, { claude: CLAUDE, codex: CODEX, cursor: CURSOR });
  const preview = importer.preview("claude");
  expect(preview.sessions).toBe(1);
  expect(preview.newCount).toBe(4);
  expect(preview.seenCount).toBe(0);
  const log: Array<{ kind: string; text: string; date: string }> = [];
  const first = importer.apply(
    "claude",
    undefined,
    (line) => {
      const msg = { kind: line.kind, text: line.text, date: line.at } as const;
      log.push(msg);
      return msg as never;
    },
    (line) => alreadyInLog(log as never, line),
  );
  expect(first.applied).toBe(4);
  expect(log.map((m) => m.kind)).toEqual(["user", "talk", "user", "talk"]);
  const again = importer.apply(
    "claude",
    undefined,
    () => {
      throw new Error("should not append");
    },
    (line) => alreadyInLog(log as never, line),
  );
  expect(again.applied).toBe(0);
  expect(again.preview.newCount).toBe(0);
  expect(again.preview.seenCount).toBe(4);
});

test("--since keeps only later lines", () => {
  const importer = new Importer(tmpDir("ncli-import-since-"), { claude: CLAUDE, codex: CODEX, cursor: CURSOR });
  const preview = importer.preview("claude", "2026-10-08T14:03:00.000Z");
  expect(preview.lines.map((l) => l.text)).toEqual([
    "e se o cupom vier depois?",
    "Cupom depois do desconto de membro, ainda antes do imposto.",
  ]);
  expect(preview.skipped).toBe(2);
});

test("hub slash previews and apply writes the log then pumps", async () => {
  const { hub } = await makeHub({
    importClaude: CLAUDE,
    importCodex: CODEX,
    importCursor: CURSOR,
  });
  await hub.send("/ncli import claude");
  const note = hub.memory.log.find((m) => m.kind === "note" && m.text.startsWith("import claude"));
  expect(note?.text).toContain("4 novas");
  expect(note?.text).toContain("--apply");
  expect(note?.text).not.toContain(CLAUDE);
  expect(hub.lastImport?.newCount).toBe(4);
  expect(hub.memory.log.filter((m) => m.hops === "import:claude")).toHaveLength(0);
  await hub.send("/ncli import claude --apply");
  const imported = hub.memory.log.filter((m) => m.hops === "import:claude");
  expect(imported.map((m) => m.text)).toContain("como funciona o desconto FACT_MEMBER_DISCOUNT_BEFORE_TAX?");
  expect(imported).toHaveLength(4);
  await hub.send("/ncli import claude --apply");
  expect(hub.memory.log.filter((m) => m.hops === "import:claude")).toHaveLength(4);
  expect(hub.lastImport?.newCount).toBe(0);
});

test("import never writes the source jsonl", () => {
  const file = join(CLAUDE, "workspace/sess-desconto.jsonl");
  const before = statSync(file);
  const raw = readFileSync(file, "utf8");
  const importer = new Importer(tmpDir("ncli-import-ro-"), { claude: CLAUDE, codex: CODEX, cursor: CURSOR });
  importer.preview("claude");
  importer.apply("claude", undefined, () => undefined as never, () => false);
  expect(readFileSync(file, "utf8")).toBe(raw);
  expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
});

test("empty root previews zero sessions", () => {
  const empty = tmpDir("ncli-import-empty-");
  mkdirSync(empty, { recursive: true });
  const importer = new Importer(tmpDir("ncli-import-led-"), { claude: empty, codex: empty, cursor: empty });
  expect(importer.preview("cursor")).toMatchObject({ sessions: 0, newCount: 0, seenCount: 0 });
});

test("cursor default projects root ignores jsonl outside agent-transcripts", () => {
  const root = tmpDir("ncli-cursor-projects-");
  mkdirSync(join(root, "workspace"), { recursive: true });
  writeFileSync(join(root, "workspace", "noise.jsonl"), `{"type":"user","text":"ruído"}\n`);
  expect(listSessionFiles(root, "cursor")).toEqual([]);
});

test("/help posts the command list and does not start a turn", async () => {
  const { hub } = await makeHub();
  try {
    await hub.send("/help");
    await hub.send("/?");
    await hub.send("/ncli");
    const notes = hub.memory.log.filter((m) => m.kind === "note").map((m) => m.text);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain("/help");
    expect(notes[0]).toContain("/ncli import");
    expect(notes[1]).toBe(notes[0]);
    expect(notes[2]).toBe(notes[0]);
    expect(hub.snapshot().turning).toBe(false);
    expect(hub.memory.log.some((m) => m.kind === "talk")).toBe(false);
  } finally {
    hub.close();
  }
});
