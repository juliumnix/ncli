import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { loadMcpRegistry, resolveServers, spawnVars } from "../src/mcp/registry";
import { asClaudeMap, codexMcpFlags, prepareSpawn } from "../src/mcp/inject";
import { isNcliAutoTool, NCLI_TOOLS } from "../src/mcp/tools";
import { buildClaudeArgs } from "../src/acp/claude";
import { buildCodexArgs, codexStdinPrompt } from "../src/acp/codex";
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
  expect(inj.addDir.some((d) => d.endsWith("ncli/skills/ncli-bus"))).toBe(true);
  expect(inj.addDir.every((d) => !d.includes("pstack"))).toBe(true);
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
  expect(args).toContain("--allowedTools");
  const allowed = args[args.indexOf("--allowedTools") + 1] ?? "";
  expect(allowed).not.toContain("mcp__ncli__*");
  for (const name of ["zoom", "date", "recall", "inbox", "list_views", "list_sparks", "budget"]) {
    expect(allowed.split(",")).toContain(`mcp__ncli__${name}`);
  }
  for (const name of ["supersede", "post", "ask", "open_spark", "close_spark", "switch_harness", "read"]) {
    expect(allowed.split(",")).not.toContain(`mcp__ncli__${name}`);
  }
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
  expect(args.at(-1)).toBe("-");
  expect(codexStdinPrompt({ prompt: "ping", system: "You are NCLI." })).toContain("You are NCLI.");
  expect(codexStdinPrompt({ prompt: "ping", system: "You are NCLI." })).toContain("ping");
  expect(args).toContain("-c");
  expect(args).toContain("--skip-git-repo-check");
  expect(flags.join(" ")).not.toContain("default_tools_approval_mode=");
  expect(flags.join(" ")).not.toContain("approval_policy=never");
  const enabled = JSON.parse(codexFlag(flags, "mcp_servers.ncli.enabled_tools") ?? "[]") as string[];
  expect(enabled).toEqual(NCLI_TOOLS.map((t) => t.name));
  expect(codexFlag(flags, "mcp_servers.ncli.tools.zoom.approval_mode")).toBe('"approve"');
  expect(codexFlag(flags, "mcp_servers.ncli.tools.recall.approval_mode")).toBe('"approve"');
  expect(codexFlag(flags, "mcp_servers.ncli.tools.list_views.approval_mode")).toBe('"approve"');
  expect(codexFlag(flags, "mcp_servers.ncli.tools.list_sparks.approval_mode")).toBe('"approve"');
  expect(codexFlag(flags, "mcp_servers.ncli.tools.supersede.approval_mode")).toBeUndefined();
  expect(codexFlag(flags, "mcp_servers.ncli.tools.ask.approval_mode")).toBeUndefined();
  expect(codexFlag(flags, "mcp_servers.ncli.tools.post.approval_mode")).toBeUndefined();
  const resumed = buildCodexArgs(cfg, { prompt: "ping", extraArgs: flags }, { id: "thread-1", resume: true, rotated: false });
  expect(resumed).toContain("--skip-git-repo-check");
  expect(resumed.slice(-3)).toEqual(["resume", "thread-1", "-"]);
});

function codexFlag(flags: string[], key: string): string | undefined {
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] !== "-c") continue;
    const raw = flags[i + 1] ?? "";
    const prefix = `${key}=`;
    if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return undefined;
}

test("read-only approval names are list_views and list_sparks, not every list_ prefix", () => {
  expect(isNcliAutoTool("list_views")).toBe(true);
  expect(isNcliAutoTool("list_sparks")).toBe(true);
  expect(isNcliAutoTool("list_secrets")).toBe(false);
  expect(isNcliAutoTool("zoom")).toBe(true);
  expect(isNcliAutoTool("supersede")).toBe(false);
  expect(isNcliAutoTool("ask")).toBe(false);
});

test("ncli MCP marks read tools read-only so Codex can skip the exec prompt", () => {
  const recall = NCLI_TOOLS.find((t) => t.name === "recall");
  const zoom = NCLI_TOOLS.find((t) => t.name === "zoom");
  const ask = NCLI_TOOLS.find((t) => t.name === "ask");
  expect(recall?.annotations?.readOnlyHint).toBe(true);
  expect(zoom?.annotations?.readOnlyHint).toBe(true);
  expect(ask?.annotations?.readOnlyHint).not.toBe(true);
});

test("cursor workspace mcp is only written inside a spark worktree, not the user home", () => {
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
  expect(names).toContain("open_spark");
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
