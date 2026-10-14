import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTempRepo } from "../src/sparks/worktree";

const FAKE_CODEX = join(import.meta.dir, "fixtures/fake-codex");
const FAKE_CLAUDE = join(import.meta.dir, "fixtures/fake-claude");
const REPO = join(import.meta.dir, "..");
const QUEUE_BODY = `${JSON.stringify({ jobs: [{ l: 0, i: 0, due: 1, hash: "kept" }] })}\n`;

test("a packed bunx boot injects ncli, recalls main and spark, and keeps data across a cache clear", async () => {
  const scratch = join(tmpdir(), `ncli-pack-${process.pid}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const tgz = join(scratch, "ncli.tgz");
  const packed = spawnSync("bun", ["pm", "pack", "--outfile", tgz], { cwd: REPO, encoding: "utf8" });
  if (packed.status !== 0 || !existsSync(tgz)) {
    const fallback = join(REPO, "ncli-0.1.0.tgz");
    if (existsSync(fallback)) {
      spawnSync("mv", [fallback, tgz]);
    }
  }
  expect(existsSync(tgz)).toBe(true);
  rmSync(join(REPO, "ncli-0.1.0.tgz"), { force: true });

  const project = await initTempRepo("ncli-pack-project");
  const dataDir = join(project, "data");
  const home = join(scratch, "home");
  const codexHome = join(scratch, "codex");
  const claudeDir = join(scratch, "claude");
  mkdirSync(home, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  const codexLog = join(scratch, "codex.jsonl");
  const claudeLog = join(scratch, "claude.jsonl");
  writeFileSync(codexLog, "");
  writeFileSync(claudeLog, "");
  const sha = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const uid = process.getuid?.() ?? 0;
  const env = {
    PATH: process.env.PATH ?? "/usr/bin",
    HOME: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeDir,
    LANG: "C",
    NCLI_HARNESS: "codex",
    NCLI_COMPACT: "mock",
    NCLI_GH: "mock",
    NCLI_NO_OPEN: "1",
    NCLI_VERBOSE: "1",
    NCLI_DATA: dataDir,
    NCLI_REPO: project,
    NCLI_CODEX: FAKE_CODEX,
    NCLI_CLAUDE: FAKE_CLAUDE,
    NCLI_REVISION: sha,
    FAKE_CODEX_LOG: codexLog,
    FAKE_CLAUDE_LOG: claudeLog,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };

  let server: Bun.Subprocess | undefined;
  const bodies: string[] = [];
  let logs = "";
  try {
    const firstRoot = extract(tgz, scratch, uid, "one");
    server = boot(firstRoot, project, env, (chunk) => {
      logs += chunk;
    });
    const port = await waitPort(server, () => logs);
    const marker = `pack-marker-${Date.now()}`;
    await turn(port, marker, codexLog, bodies);
    await turn(port, `${marker}-2`, codexLog, bodies);
    await turn(port, `${marker}-3`, codexLog, bodies);
    const creds = ncliCreds(readFileSync(join(dataDir, "spawn/main/mcp.json"), "utf8"), argvOf(codexLog));
    expect(creds.url).toContain(`127.0.0.1:${port}/mcp`);
    const listed = await mcp(creds, "tools/list", {}, bodies);
    const names = toolNames(listed);
    expect(names).toContain("zoom");
    expect(names).toContain("recall");
    expect(names).toContain("supersede");
    const recalled = await mcp(creds, "tools/call", { name: "recall", arguments: { pattern: marker } }, bodies);
    const mainId = recalled.match(/#(\d+) user: pack-marker-/);
    expect(mainId?.[1]).toBeDefined();

    expect(await livePids(codexLog)).toEqual([]);

    const opened = await fetch(`http://127.0.0.1:${port}/api/sparks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: "refino", params: { card: "pack" } }),
      signal: AbortSignal.timeout(8000),
    });
    const openedText = await opened.text();
    bodies.push(openedText);
    const spark = JSON.parse(openedText) as { spark?: { id?: string } };
    const sparkId = spark.spark?.id ?? "";
    expect(sparkId).toMatch(/^refino-/);
    const sparkFile = join(dataDir, "spawn", sparkId, "mcp.json");
    const sparkCreds = await waitFile(sparkFile, server);
    const sparkRecall = await mcp(ncliCreds(sparkCreds, []), "tools/call", {
      name: "recall",
      arguments: { pattern: "boot refino" },
    }, bodies);
    expect(sparkRecall).toMatch(/#\d+ note: boot refino/);
    expect(sparkRecall).not.toContain(marker);

    const treePath = join(dataDir, "main/tree.jsonl");
    expect(existsSync(treePath)).toBe(true);
    const treeBefore = readFileSync(treePath);
    const queuePath = join(dataDir, "main/compact-queue.json");
    writeFileSync(queuePath, QUEUE_BODY);
    stop(server);
    server = undefined;
    rmSync(firstRoot, { recursive: true, force: true });
    expect(existsSync(join(firstRoot, "package/src/index.ts"))).toBe(false);

    const secondRoot = extract(tgz, scratch, uid, "two");
    expect(secondRoot).not.toBe(firstRoot);
    const logMark = logs.length;
    server = boot(secondRoot, project, env, (chunk) => {
      logs += chunk;
    });
    const port2 = await waitPort(server, () => logs.slice(logMark));
    const creds2 = ncliCreds(readFileSync(join(dataDir, "spawn/main/mcp.json"), "utf8"), []);
    expect(creds2.url).toContain(`127.0.0.1:${port2}/mcp`);
    const again = await mcp(creds2, "tools/call", { name: "recall", arguments: { pattern: marker } }, bodies);
    expect(again).toContain(`#${mainId?.[1]} user: ${marker}`);
    const treeAfter = readFileSync(treePath);
    expect(Buffer.compare(treeAfter.subarray(0, treeBefore.length), treeBefore)).toBe(0);
    expect(readFileSync(queuePath, "utf8")).toBe(QUEUE_BODY);
    expect(treePath.startsWith(dataDir)).toBe(true);
    expect(treePath.startsWith(secondRoot)).toBe(false);
    expect(existsSync(join(secondRoot, "data/main/tree.jsonl"))).toBe(false);
    assertNoRoots([...bodies, logs], [home, project, join(firstRoot, "package"), join(secondRoot, "package")]);
  } finally {
    if (server) stop(server);
    rmSync(scratch, { recursive: true, force: true });
    rmSync(join(REPO, "ncli-0.1.0.tgz"), { force: true });
  }
}, 60_000);

function extract(tgz: string, scratch: string, uid: number, label: string): string {
  const root = join(scratch, `bunx-${uid}-ncli@github@${label}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const ran = spawnSync("tar", ["-xzf", tgz, "-C", root], { encoding: "utf8" });
  if (ran.status !== 0) throw new Error(ran.stderr || "tar failed");
  return root;
}

function boot(
  root: string,
  cwd: string,
  env: Record<string, string>,
  onLog: (chunk: string) => void,
): Bun.Subprocess {
  const entry = join(root, "package/src/index.ts");
  expect(existsSync(entry)).toBe(true);
  const proc = Bun.spawn([process.execPath, entry], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  if (stdout && typeof stdout !== "number") void drain(stdout, onLog);
  if (stderr && typeof stderr !== "number") void drain(stderr, onLog);
  return proc;
}

async function drain(stream: ReadableStream<Uint8Array>, onLog: (chunk: string) => void): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      onLog(dec.decode(next.value));
    }
  } finally {
    reader.releaseLock();
  }
}

async function waitPort(proc: Bun.Subprocess, readLog: () => string): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    const match = readLog().match(/localhost:(\d+)/);
    if (match?.[1]) return Number(match[1]);
    if (proc.exitCode !== null) break;
    await Bun.sleep(40);
  }
  throw new Error(scrub(readLog()).slice(0, 400) || "no banner");
}

async function turn(port: number, text: string, codexLog: string, bodies: string[]): Promise<void> {
  const posted = await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(4000),
  });
  bodies.push(await posted.text());
  expect(posted.ok).toBe(true);
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const stateRes = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) });
    const stateText = await stateRes.text();
    bodies.push(stateText);
    const state = JSON.parse(stateText) as {
      turning?: boolean;
      turn?: { status?: string };
      messages?: Array<{ kind?: string; text?: string }>;
    };
    const saw = state.messages?.some((msg) => msg.kind === "user" && msg.text === text);
    if (saw && state.turning === false && state.turn?.status === "done") {
      expect(await livePids(codexLog)).toEqual([]);
      return;
    }
    await Bun.sleep(40);
  }
  throw new Error(`turn did not finish: ${text}`);
}

function argvOf(logPath: string): string[] {
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const last = lines.at(-1);
  if (!last) return [];
  return (JSON.parse(last) as { argv?: string[] }).argv ?? [];
}

function ncliCreds(file: string, argv: string[]): { url: string; token: string } {
  const json = JSON.parse(file) as { mcpServers?: { ncli?: { url?: string; headers?: { Authorization?: string } } } };
  let url = json.mcpServers?.ncli?.url ?? "";
  let token = (json.mcpServers?.ncli?.headers?.Authorization ?? "").replace(/^Bearer\s+/, "");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "-c") continue;
    const value = argv[i + 1] ?? "";
    if (value.startsWith("mcp_servers.ncli.url=")) url = value.slice("mcp_servers.ncli.url=".length);
    const bearer = /Authorization=Bearer\s+(\S+)/.exec(value);
    if (bearer?.[1]) token = bearer[1];
  }
  return { url, token };
}

async function mcp(
  creds: { url: string; token: string },
  method: string,
  params: unknown,
  bodies: string[],
): Promise<string> {
  const res = await fetch(creds.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${creds.token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(4000),
  });
  const text = await res.text();
  bodies.push(text);
  expect(res.status).toBe(200);
  return text;
}

function assertNoRoots(chunks: string[], roots: string[]): void {
  const text = chunks.join("\n");
  for (const root of roots) {
    if (root && text.includes(root)) throw new Error("output leaked a private root");
  }
}

function scrub(text: string): string {
  return text.replace(/(^|[\s"'=])\/[^\s"']+/g, "$1<path>");
}

function toolNames(body: string): string[] {
  const json = JSON.parse(body) as { result?: { tools?: Array<{ name?: string }> } };
  return (json.result?.tools ?? []).map((tool) => tool.name ?? "");
}

async function livePids(logPath: string): Promise<number[]> {
  if (!logPath || !existsSync(logPath)) return [];
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
    await Bun.sleep(40);
  }
  return alive;
}

async function waitFile(path: string, proc: Bun.Subprocess): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    if (proc.exitCode !== null) break;
    await Bun.sleep(40);
  }
  throw new Error(`missing ${path}`);
}

function stop(proc: Bun.Subprocess): void {
  proc.kill();
}
