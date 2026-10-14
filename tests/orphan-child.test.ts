import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Memory } from "../src/memory/store";
import { tmpDir } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const PARENT = join(import.meta.dir, "fixtures/orphan-parent.ts");
const CHILD = join(import.meta.dir, "fixtures/orphan-child.ts");
const INDEX = join(ROOT, "src/index.ts");
const REV = "f5670f2f5670f2f5670f2f5670f2f5670f2f567";
const spawned: number[] = [];

afterAll(() => {
  for (const pid of spawned) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port;
  s.stop(true);
  return p;
}

function env(data: string, port: number, extra: Record<string, string> = {}): Record<string, string> {
  const home = join(data, "home");
  const repo = join(data, "repo");
  mkdirSync(home, { recursive: true });
  if (!existsSync(join(repo, ".git"))) {
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  }
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NCLI_DATA: join(data, "ncli"),
    NCLI_REPO: repo,
    NCLI_NO_OPEN: "1",
    NCLI_PORT: String(port),
    NCLI_LIVE_PORT: String(freePort()),
    NCLI_HARNESS: "mock",
    NCLI_COMPACT: "mock",
    NCLI_REVISION: REV,
    NCLI_NODE: "60",
    NCLI_COMPACT_SKIP: "1",
    NCLI_COMPACT_DEBOUNCE: "5",
    ...extra,
  };
}

async function portOpen(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(300) });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(25);
  }
  return Boolean(await fn());
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const st = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^\d+ \(.*\) Z /.test(st);
  } catch {
    return false;
  }
}

function childrenOf(pid: number): number[] {
  const out: number[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
      if (ppid === pid) out.push(Number(d));
    } catch {}
  }
  return out;
}

async function launch(childArgv: string[], e: Record<string, string>, port: number) {
  const parent = Bun.spawn(["bun", PARENT, ...childArgv], { env: e, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  spawned.push(parent.pid);
  expect(await waitFor(() => portOpen(port), 15_000)).toBe(true);
  const kids = childrenOf(parent.pid);
  expect(kids.length).toBe(1);
  spawned.push(kids[0]!);
  return { parent, child: kids[0]! };
}

async function killParent(sig: "SIGTERM" | "SIGKILL", parentPid: number, child: number, port: number) {
  const t0 = performance.now();
  process.kill(parentPid, sig);
  const died = await waitFor(async () => !alive(child) && !(await portOpen(port)), 2_000);
  const ms = Math.round(performance.now() - t0);
  console.log(`[orphan] ${sig}: child dead=${!alive(child)} port open=${await portOpen(port)} after ${ms}ms`);
  return died;
}

test("SIGTERM to the re-exec parent stops the child within 2s and frees the port", async () => {
  const port = freePort();
  const e = env(tmpDir("orphan-term"), port);
  const { parent, child } = await launch(["bun", INDEX], e, port);
  expect(await killParent("SIGTERM", parent.pid, child, port)).toBe(true);
  expect(await parent.exited).toBe(143);
}, 30_000);

test("SIGKILL to the re-exec parent stops the orphan child within 2s and frees the port", async () => {
  const port = freePort();
  const e = env(tmpDir("orphan-kill"), port);
  const { parent, child } = await launch(["bun", INDEX], e, port);
  expect(await killParent("SIGKILL", parent.pid, child, port)).toBe(true);
}, 30_000);

function jsonlIntact(dir: string): { files: number; lines: number } {
  let files = 0;
  let lines = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    files += 1;
    const raw = readFileSync(join(dir, f), "utf8");
    if (raw.length) expect(raw.endsWith("\n")).toBe(true);
    for (const line of raw.split("\n").filter(Boolean)) {
      JSON.parse(line);
      lines += 1;
    }
  }
  return { files, lines };
}

function treeKeys(dir: string): string[] {
  const p = join(dir, "tree.jsonl");
  if (!existsSync(p)) return [];
  const out: string[] = [];
  for (const line of readFileSync(p, "utf8").split("\n").filter(Boolean)) {
    const n = JSON.parse(line) as { l: number; i: number; text?: string; dropped?: boolean };
    // tree.jsonl is last-wins (local node, then refined); a resumed queue that redid
    // persisted work would append the same (key, text) twice.
    if (!n.dropped) out.push(`${n.l}:${n.i}:${n.text}`);
  }
  return out;
}

test("killing the parent mid-turn and mid-compaction leaves intact jsonl, no codex exec, and resumes cleanly", async () => {
  const data = tmpDir("orphan-batch");
  const bin = join(data, "bin");
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, "codex");
  writeFileSync(fake, "#!/usr/bin/env bun\nawait Bun.sleep(60_000);\n");
  chmodSync(fake, 0o755);
  const pids = join(data, "codex-pids.txt");
  writeFileSync(pids, "");
  const port = freePort();
  const e = env(data, port, { NCLI_TEST_FAKE_CODEX: fake, NCLI_TEST_CODEX_PIDS: pids });
  const { parent, child } = await launch(["bun", CHILD], e, port);
  const token = `ORPHAN_TOKEN_${Date.now()}`;
  for (let k = 0; k < 4; k++) {
    await fetch(`http://127.0.0.1:${port}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `${token} turno ${k} `.repeat(12) }),
    });
    await Bun.sleep(150);
  }
  const codexPids = () => readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
  expect(await waitFor(() => codexPids().some(alive), 8_000)).toBe(true);
  for (const p of codexPids()) spawned.push(p);
  await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `${token} mid-turn` }),
  });
  expect(await killParent("SIGKILL", parent.pid, child, port)).toBe(true);
  const leftover = codexPids().filter(alive);
  console.log(`[orphan] mid-batch: codex exec leftover=${leftover.length} (spawned ${codexPids().length})`);
  expect(leftover.length).toBe(0);

  const memDir = join(e.NCLI_DATA!, "main");
  const before = jsonlIntact(memDir);
  expect(before.lines).toBeGreaterThan(0);
  const probe = new Memory({ dir: memDir, nodeBytes: 60, viewBytes: 2500, compressor: async () => "x" });
  probe.paused = true;
  const hitsBefore = probe.recall(token);
  expect(hitsBefore.length).toBeGreaterThan(0);

  const port2 = freePort();
  const e2 = env(data, port2);
  const again = await launch(["bun", CHILD], e2, port2);
  await Bun.sleep(1_500);
  process.kill(again.parent.pid, "SIGTERM");
  expect(await waitFor(() => !alive(again.child), 3_000)).toBe(true);
  jsonlIntact(memDir);
  const keys = treeKeys(memDir);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys.length).toBeGreaterThan(0);
  const after = new Memory({ dir: memDir, nodeBytes: 60, viewBytes: 2500, compressor: async () => "x" });
  after.paused = true;
  expect(after.recall(token)[0]).toBe(hitsBefore[0]);
}, 60_000);
