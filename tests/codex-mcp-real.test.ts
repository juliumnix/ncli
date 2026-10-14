import { expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { loadConfig } from "../src/config";
import { codexMcpFlags } from "../src/mcp/inject";
import { loadMcpRegistry, resolveServers, spawnVars } from "../src/mcp/registry";
import { NCLI_TOOLS } from "../src/mcp/tools";

const found = findCodex160();
if ("skip" in found) console.warn(found.skip);

test.skipIf("skip" in found)("codex 0.160.1 lists every ncli MCP tool from the spawn flags", async () => {
  if (!("bin" in found)) return;
  const dataDir = mkdtempSync(join(tmpdir(), "ncli-codex-mcp-"));
  const repo = mkdtempSync(join(tmpdir(), "ncli-codex-repo-"));
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
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const token = booted.hub.mcp.mint("main");
    const servers = resolveServers(
      loadMcpRegistry(process.cwd()),
      spawnVars(cfg, "main", { NCLI_MCP_URL: booted.report.mcpUrl, NCLI_MCP_TOKEN: token }),
    );
    const flags = codexMcpFlags(servers);
    child = spawn(found.bin, ["app-server", "--listen", "stdio://", ...flags], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home, LANG: process.env.LANG ?? "C" },
    });
    const stderr: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString());
      if (stderr.join("").length > 4000) stderr.splice(0, stderr.length - 1);
    });
    const lines = readLines(child);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "ncli-test", version: "0" } },
      })}\n`,
    );
    await waitFor(lines, (line) => jsonId(line) === 1, "codex app-server initialize");
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "mcpServerStatus/list",
        params: { serverName: "ncli", detail: "toolsAndAuthOnly" },
      })}\n`,
    );
    const listed = await waitFor(lines, (line) => jsonId(line) === 2, "codex mcpServerStatus/list");
    const body = JSON.parse(listed) as {
      result?: { data?: Array<{ name?: string; tools?: Record<string, { name?: string }>; toolsError?: string | null }> };
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? stderr.join("").slice(0, 500));
    const entry = body.result?.data?.find((row) => row.name === "ncli");
    expect(entry?.toolsError ?? null).toBeNull();
    const names = Object.keys(entry?.tools ?? {}).sort();
    expect(names).toEqual(NCLI_TOOLS.map((tool) => tool.name).sort());
  } finally {
    child?.kill();
    booted.stop();
  }
});

function findCodex160(): { bin: string } | { skip: string } {
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
  return {
    skip: `skip: @openai/codex@0.160.1 is not installed (${notes.join("; ")}). Install with npm install -g @openai/codex@0.160.1`,
  };
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

async function waitFor(lines: string[], match: (line: string) => boolean, what: string): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < 12000) {
    const line = lines.find(match);
    if (line) return line;
    await Bun.sleep(30);
  }
  throw new Error(`${what} timed out`);
}
