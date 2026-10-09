import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { loadMcpRegistry, resolveServers, spawnVars } from "../src/mcp/registry";
import { asClaudeMap, codexMcpFlags, prepareSpawn } from "../src/mcp/inject";
import { NCLI_TOOLS } from "../src/mcp/tools";
import { buildClaudeArgs } from "../src/acp/claude";
import { buildCodexArgs } from "../src/acp/codex";
import { busRpc } from "../src/bus/client";
import { makeHub, tmpDir } from "./helpers";

test("ncli/mcp.json registers the one ncli HTTP server", () => {
  const reg = loadMcpRegistry(process.cwd());
  expect(reg.servers.map((s) => s.name)).toContain("ncli");
  expect(reg.servers[0]?.type).toBe("http");
  expect(reg.servers[0]?.url).toContain("NCLI_MCP_URL");
});

test("prepareSpawn writes under data/spawn and never touches ~/.claude ~/.codex ~/.cursor", () => {
  const dataDir = tmpDir("spawn");
  const cfg = loadConfig({ dataDir, repo: dataDir, ncliRoot: process.cwd(), harness: "claude" });
  const inj = prepareSpawn({
    cfg,
    session: "main",
    harness: "claude",
    token: "abc",
    mcpUrl: "http://127.0.0.1:47231/mcp",
  });
  expect(inj.mcpConfigPath.startsWith(dataDir)).toBe(true);
  expect(inj.mcpConfigPath).toContain("/spawn/");
  const json = JSON.parse(readFileSync(inj.mcpConfigPath, "utf8")) as {
    mcpServers: { ncli: { type: string; url: string; headers: { Authorization: string } } };
  };
  expect(json.mcpServers.ncli.type).toBe("http");
  expect(json.mcpServers.ncli.url).toBe("http://127.0.0.1:47231/mcp");
  expect(json.mcpServers.ncli.headers.Authorization).toBe("Bearer abc");
  expect(inj.addDir.some((d) => d.endsWith("ncli/skills"))).toBe(true);
  const home = homedir();
  for (const banned of [join(home, ".claude"), join(home, ".codex"), join(home, ".cursor")]) {
    expect(inj.mcpConfigPath.startsWith(banned)).toBe(false);
    expect(existsSync(join(banned, "ncli-from-test.json"))).toBe(false);
  }
});

test("claude spawn gets --mcp-config --strict-mcp-config and --add-dir skills", () => {
  const dataDir = tmpDir("claude-inj");
  const cfg = loadConfig({ dataDir, ncliRoot: process.cwd(), claudeBin: "claude" });
  const inj = prepareSpawn({ cfg, session: "main", harness: "claude", token: "t", mcpUrl: "http://127.0.0.1:9/mcp" });
  const args = buildClaudeArgs(cfg, {
    prompt: "oi",
    mcpConfigPath: inj.mcpConfigPath,
    addDir: inj.addDir,
    session: "s1",
  });
  expect(args).toContain("--mcp-config");
  expect(args).toContain("--strict-mcp-config");
  expect(args).toContain("--include-partial-messages");
  expect(args).toContain("--add-dir");
  expect(args).toContain(inj.addDir[0]);
});

test("codex spawn gets -c mcp_servers.ncli.url and the system prompt in the prompt", () => {
  const servers = resolveServers(
    loadMcpRegistry(process.cwd()),
    spawnVars(loadConfig({ dataDir: tmpDir("cx"), ncliRoot: process.cwd() }), "main", {
      NCLI_MCP_URL: "http://127.0.0.1:47231/mcp",
      NCLI_MCP_TOKEN: "tok",
    }),
  );
  const flags = codexMcpFlags(servers);
  expect(flags.join(" ")).toContain("mcp_servers.ncli.url=http://127.0.0.1:47231/mcp");
  expect(flags.join(" ")).not.toContain("src/mcp/server.ts");
  const cfg = loadConfig({ dataDir: tmpDir("cx2"), ncliRoot: process.cwd(), codexBin: "codex" });
  const args = buildCodexArgs(cfg, { prompt: "ping", system: "You are NCLI.", extraArgs: flags });
  expect(args.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
  expect(args.at(-1)).toContain("You are NCLI.");
  expect(args.at(-1)).toContain("ping");
  expect(args).toContain("-c");
});

test("cursor workspace mcp is only written inside a fork worktree, not the user home", () => {
  const repo = tmpDir("repo");
  const dataDir = tmpDir("data");
  const wt = join(repo, ".ncli", "wt", "review-1");
  const cfg = loadConfig({ dataDir, repo, ncliRoot: process.cwd() });
  prepareSpawn({ cfg, session: "review-1", harness: "cursor", worktree: wt, token: "t", mcpUrl: "http://127.0.0.1:47231/mcp" });
  expect(existsSync(join(wt, ".cursor", "mcp.json"))).toBe(true);
  expect(readFileSync(join(wt, ".cursor", "mcp.json"), "utf8")).toContain('"type": "http"');
  expect(existsSync(join(homedir(), ".cursor", "mcp.json")) && readFileSync(join(homedir(), ".cursor", "mcp.json"), "utf8").includes(dataDir)).toBe(false);
});

test("the ncli MCP tool list is one surface: memory, bus, control", () => {
  const names = NCLI_TOOLS.map((t) => t.name);
  expect(names).toContain("zoom");
  expect(names).toContain("ask");
  expect(names).toContain("open_fork");
  expect(names).toContain("switch_harness");
  expect(names).toContain("budget");
  expect(names).toContain("ncli.render");
});

test("asClaudeMap keeps the ncli HTTP entry for --mcp-config", () => {
  const map = asClaudeMap([{ name: "ncli", type: "http", url: "http://127.0.0.1/mcp", headers: { Authorization: "Bearer x" } }]);
  expect(map.ncli.type).toBe("http");
  expect(map.ncli.url).toBe("http://127.0.0.1/mcp");
});

test("control tools ride the same unix socket as the bus", async () => {
  const { hub } = await makeHub();
  try {
    const r = await busRpc(hub.bus.socketPath, {
      from: "main",
      kind: "event",
      op: "mcp",
      body: JSON.stringify({ name: "list_views", args: {} }),
    });
    expect(r.body).toContain("review");
    const switched = await busRpc(hub.bus.socketPath, {
      from: "main",
      kind: "event",
      op: "mcp",
      body: JSON.stringify({ name: "switch_harness", args: { harness: "codex" } }),
    });
    expect(switched.body).toContain("codex");
    expect(hub.harness.id).toBe("codex");
  } finally {
    hub.close();
  }
});
