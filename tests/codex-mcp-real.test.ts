import { expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootNcli, type Booted } from "../src/boot";
import { loadConfig } from "../src/config";
import { NCLI_TOOLS } from "../src/mcp/tools";
import { initTempRepo } from "../src/sparks/worktree";

const CATALOG = NCLI_TOOLS.map((tool) => tool.name).sort();
const probe = findCodex160();

test("a missing codex 0.160.1 fails the catalog check when CI=true", () => {
  const reason = missingCodexReason("codex: not found");
  expect(codexCatalogGate({ CI: "true" }, { missing: "codex: not found" })).toEqual({ action: "fail", reason });
  expect(codexCatalogGate({ CI: "1" }, { missing: "codex: not found" })).toEqual({ action: "fail", reason });
});

test("a missing codex 0.160.1 names the skip when CI is unset", () => {
  expect(codexCatalogGate({}, { missing: "codex: not found" })).toEqual({
    action: "skip",
    reason: missingCodexReason("codex: not found"),
  });
});

registerCatalog("codex 0.160.1 lists every ncli MCP tool from the spawn flags", async (bin) => {
  await withBoot(async (booted) => {
    const inj = booted.hub.injectSpawn("main", "codex");
    expect(booted.hub.mcp.lookup(inj.token)?.session).toBe("main");
    expect(await catalogFrom(bin, inj.extraArgs)).toEqual(CATALOG);
  });
});

registerCatalog("codex 0.160.1 re-enables a disabled ncli and keeps servers added between spawns", async (bin) => {
  await withBoot(async (booted) => {
    const inj = booted.hub.injectSpawn("main", "codex");
    expect(inj.extraArgs).toContain("mcp_servers.ncli.enabled=true");
    const home = mkdtempSync(join(tmpdir(), "codex-user-"));
    const config = join(home, "config.toml");
    writeFileSync(
      config,
      `[mcp_servers.other]\ncommand = "fake-other"\nargs = ["serve"]\n\n[mcp_servers.ncli]\nenabled = false\nurl = "http://127.0.0.1:9/mcp"\n`,
    );
    const cwd = mkdtempSync(join(tmpdir(), "codex-cwd-"));
    const first = await mcpRows(bin, inj.extraArgs, home, cwd);
    expect(namesOf(first)).toEqual(["ncli", "other"]);
    expect(toolNames(first, "ncli")).toEqual(CATALOG);
    const third = `\n[mcp_servers.third]\ncommand = "fake-third"\nargs = ["serve"]\n`;
    writeFileSync(config, `${readFileSync(config, "utf8")}${third}`);
    const second = await mcpRows(bin, inj.extraArgs, home, cwd);
    expect(namesOf(second)).toEqual(["ncli", "other", "third"]);
    expect(toolNames(second, "ncli")).toEqual(CATALOG);
  });
});

registerCatalog("codex 0.160.1 lists zoom, recall, and every ncli tool for spark:<id>", async (bin) => {
  await withBoot(async (booted) => {
    const rt = await booted.hub.sparks.open("refino", { card: "codex-mcp" });
    const session = `spark:${rt.spark.id}`;
    const inj = booted.hub.injectSpawn(session, "codex", rt.worktree?.path);
    expect(booted.hub.mcp.lookup(inj.token)?.session).toBe(session);
    expect(inj.extraArgs).toContain(`mcp_servers.ncli.http_headers.Authorization=Bearer ${inj.token}`);
    const names = await catalogFrom(bin, inj.extraArgs);
    expect(names).toEqual(CATALOG);
    expect(names).toContain("zoom");
    expect(names).toContain("recall");
    expect(names).toContain("supersede");
  });
});

type CodexProbe = { bin: string } | { missing: string };
type CodexGate = { action: "run"; bin: string } | { action: "fail" | "skip"; reason: string };

function codexCatalogGate(env: NodeJS.ProcessEnv, found: CodexProbe): CodexGate {
  if ("bin" in found) return { action: "run", bin: found.bin };
  const reason = missingCodexReason(found.missing);
  const ci = (env.CI ?? "").trim().toLowerCase();
  if (ci === "true" || ci === "1") return { action: "fail", reason };
  return { action: "skip", reason };
}

function missingCodexReason(detail: string): string {
  return `skip: @openai/codex@0.160.1 is not installed (${detail}). Install with npm install -g @openai/codex@0.160.1`;
}

function registerCatalog(title: string, body: (bin: string) => Promise<void>): void {
  const gate = codexCatalogGate(process.env, probe);
  switch (gate.action) {
    case "skip":
      test.skip(`${title} (${gate.reason})`, () => {});
      return;
    case "fail":
      test(title, () => {
        throw new Error(gate.reason);
      });
      return;
    case "run":
      test(title, () => body(gate.bin));
      return;
    default: {
      const _never: never = gate;
      throw new Error(String(_never));
    }
  }
}

function findCodex160(): CodexProbe {
  const candidates = [process.env.NCLI_CODEX?.trim(), "codex"].filter((bin): bin is string => Boolean(bin));
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const bin of candidates) {
    if (seen.has(bin)) continue;
    seen.add(bin);
    const run = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 8000 });
    const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
    if (run.status === 0 && /\b0\.160\.1\b/.test(text)) return { bin };
    notes.push(text ? `${bin}: ${text.split("\n")[0]}` : `${bin}: not found`);
  }
  return { missing: notes.join("; ") || "codex: not found" };
}

async function withBoot(body: (booted: Booted) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "ncli-codex-mcp-"));
  const repo = await initTempRepo("ncli-codex-repo");
  const cfg = loadConfig({
    dataDir,
    repo,
    ncliRoot: process.cwd(),
    harness: "mock",
    compactBackend: "mock",
    demo: false,
    ghMode: "mock",
    port: 0,
  });
  const booted = await bootNcli({ cfg, root: process.cwd(), openBrowser: false });
  try {
    await body(booted);
  } finally {
    booted.stop();
  }
}

type McpRow = { name?: string; tools?: Record<string, { name?: string }>; toolsError?: string | null };

function namesOf(rows: McpRow[]): string[] {
  return rows.map((row) => row.name ?? "").filter(Boolean).sort();
}

function toolNames(rows: McpRow[], server: string): string[] {
  const entry = rows.find((row) => row.name === server);
  expect(entry?.toolsError ?? null).toBeNull();
  return Object.keys(entry?.tools ?? {}).sort();
}

async function catalogFrom(bin: string, flags: string[]): Promise<string[]> {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const rows = await mcpRows(bin, flags, home, process.cwd(), "ncli");
  return toolNames(rows, "ncli");
}

async function mcpRows(bin: string, flags: string[], home: string, cwd: string, serverName?: string): Promise<McpRow[]> {
  const child = spawn(bin, ["app-server", "--listen", "stdio://", ...flags], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home, LANG: process.env.LANG ?? "C" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  try {
    const lines = readLines(child);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "ncli-test", version: "0" } },
      })}\n`,
    );
    await waitFor(lines, (line) => jsonId(line) === 1, "codex app-server initialize", () => stderr);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "mcpServerStatus/list",
        params: serverName ? { serverName, detail: "toolsAndAuthOnly" } : { detail: "toolsAndAuthOnly" },
      })}\n`,
    );
    const listed = await waitFor(lines, (line) => jsonId(line) === 2, "codex mcpServerStatus/list", () => stderr);
    const body = JSON.parse(listed) as {
      result?: { data?: McpRow[] };
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? stderr.slice(0, 500));
    return body.result?.data ?? [];
  } finally {
    child.kill();
  }
}

function readLines(child: ChildProcessWithoutNullStreams): string[] {
  const lines: string[] = [];
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) lines.push(line);
      nl = buf.indexOf("\n");
    }
  });
  return lines;
}

function jsonId(line: string): number | undefined {
  try {
    const id = (JSON.parse(line) as { id?: unknown }).id;
    return typeof id === "number" ? id : undefined;
  } catch {
    return undefined;
  }
}

async function waitFor(
  lines: string[],
  match: (line: string) => boolean,
  what: string,
  detail: () => string,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < 12000) {
    const line = lines.find(match);
    if (line) return line;
    await Bun.sleep(30);
  }
  throw new Error(`${what} timed out\n${detail().slice(0, 500)}`);
}
