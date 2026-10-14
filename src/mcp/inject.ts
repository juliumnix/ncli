import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { NcliConfig } from "../config";
import { defaultSkillsDir, runtimeSkillDirs } from "../skills/catalog";
import { loadMcpFile, loadMcpRegistry, resolveServers, spawnVars, type McpServerSpec } from "./registry";
import { NCLI_TOOLS, ncliAutoToolNames } from "./tools";

export interface SpawnInject {
  dir: string;
  mcpConfigPath: string;
  extraArgs: string[];
  mcpServers: McpServerSpec[];
  addDir: string[];
  agentsMd: string;
  token: string;
  mcpUrl: string;
}

export function prepareSpawn(opts: {
  cfg: NcliConfig;
  session: string;
  harness: string;
  worktree?: string;
  ticket?: string;
  token?: string;
  mcpUrl?: string;
  addDir?: string[];
  agentsMd?: string;
  extraMcp?: string;
}): SpawnInject {
  const token = opts.token ?? "";
  const mcpUrl = opts.mcpUrl ?? `http://127.0.0.1:${opts.cfg.port}/mcp`;
  const vars = spawnVars(opts.cfg, opts.session, {
    NCLI_TICKET: opts.ticket ?? "",
    NCLI_MCP_TOKEN: token,
    NCLI_MCP_URL: mcpUrl,
  });
  const extra = opts.extraMcp
    ? resolveServers({ servers: loadMcpFile(opts.extraMcp), path: opts.extraMcp }, vars)
    : [];
  const servers = [...resolveServers(loadMcpRegistry(opts.cfg.pkgRoot), vars), ...extra];
  const dir = join(opts.cfg.dataDir, "spawn", opts.session.replace(/[^a-zA-Z0-9._-]/g, "_"));
  assertLocal(dir, opts.cfg.dataDir);
  mkdirSync(dir, { recursive: true });
  const mcpConfigPath = join(dir, "mcp.json");
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: asClaudeMap(servers) }, null, 2), "utf8");
  const skills = defaultSkillsDir(opts.cfg.ncliRoot);
  const addDir = opts.addDir ?? runtimeSkillDirs(skills);
  const agentsMd = opts.agentsMd ?? agentsBlock(skills);
  writeFileSync(join(dir, "AGENTS.md"), agentsMd, "utf8");
  const extraArgs = extraFor(opts.harness, servers, addDir);
  maybeWriteCursorWorkspace(opts.worktree, opts.cfg, servers, agentsMd);
  return {
    dir,
    mcpConfigPath,
    extraArgs,
    mcpServers: servers,
    addDir,
    agentsMd,
    token,
    mcpUrl,
  };
}

export function extraFor(harness: string, servers: McpServerSpec[], skillsDir: string | string[]): string[] {
  switch (harness) {
    case "claude":
      return (Array.isArray(skillsDir) ? skillsDir : [skillsDir]).flatMap((d) => ["--add-dir", d]);
    case "codex":
      return codexMcpFlags(servers);
    case "cursor":
    case "mock":
    case "auto":
      return [];
    default:
      return [];
  }
}

export function codexMcpFlags(servers: McpServerSpec[]): string[] {
  const out: string[] = [];
  for (const s of servers) {
    if (s.type === "http" && s.url) {
      out.push("-c", `mcp_servers.${s.name}.url=${s.url}`);
      for (const [k, v] of Object.entries(s.headers ?? {})) {
        if (!v) continue;
        out.push("-c", `mcp_servers.${s.name}.http_headers.${k}=${v}`);
      }
      if (s.name === "ncli") out.push(...codexNcliTrustFlags(s.name));
      continue;
    }
    out.push("-c", `mcp_servers.${s.name}.command=${s.command ?? "bun"}`);
    out.push("-c", `mcp_servers.${s.name}.args=${JSON.stringify(s.args ?? [])}`);
    for (const [k, v] of Object.entries(s.env ?? {})) {
      if (!v) continue;
      out.push("-c", `mcp_servers.${s.name}.env.${k}=${v}`);
    }
    if (s.name === "ncli") out.push(...codexNcliTrustFlags(s.name));
  }
  return out;
}

export function codexNcliTrustFlags(name = "ncli"): string[] {
  const flags = [
    "-c",
    `mcp_servers.${name}.enabled=true`,
    "-c",
    `mcp_servers.${name}.enabled_tools=${JSON.stringify(NCLI_TOOLS.map((tool) => tool.name))}`,
  ];
  for (const tool of ncliAutoToolNames()) {
    flags.push("-c", `mcp_servers.${name}.tools.${tool}.approval_mode="approve"`);
  }
  return flags;
}

export function asClaudeMap(servers: McpServerSpec[]): Record<string, Record<string, unknown>> {
  const map: Record<string, Record<string, unknown>> = {};
  for (const s of servers) {
    if (s.type === "http" && s.url) {
      map[s.name] = { type: "http", url: s.url, headers: s.headers ?? {} };
      continue;
    }
    map[s.name] = { command: s.command ?? "bun", args: s.args ?? [], env: s.env ?? {} };
  }
  return map;
}

function agentsBlock(skillsDir: string): string {
  return `NCLI runtime skills live in ${skillsDir} (ncli-bus, views, and the other ncli/skills/<id> folders).
Read ncli/skills/<id>/SKILL.md for NCLI flows.
Read ncli/skills/emil/emil-design-eng/SKILL.md when the work is UI.
Talk to Codex or Cursor with the ncli MCP tools ask / wait / post / inbox / read.
MCP tools come from the ncli HTTP server already running on this machine.
`;
}

function maybeWriteCursorWorkspace(
  worktree: string | undefined,
  cfg: NcliConfig,
  servers: McpServerSpec[],
  agentsMd: string,
): void {
  if (!worktree) return;
  const wt = resolve(worktree);
  if (!wt.includes(`${join(".ncli", "wt")}`)) return;
  assertLocal(wt, resolve(cfg.repo));
  const cursorDir = join(wt, ".cursor");
  mkdirSync(join(cursorDir, "rules"), { recursive: true });
  writeFileSync(join(cursorDir, "mcp.json"), JSON.stringify({ mcpServers: asClaudeMap(servers) }, null, 2), "utf8");
  writeFileSync(join(cursorDir, "rules", "ncli-skills.mdc"), `---\nalwaysApply: true\n---\n${agentsMd}`, "utf8");
}

function assertLocal(path: string, root: string): void {
  const abs = resolve(path);
  const home = homedir();
  for (const banned of [join(home, ".claude"), join(home, ".codex"), join(home, ".cursor")]) {
    if (abs === banned || abs.startsWith(`${banned}/`)) {
      throw new Error(`refusing to write MCP/skills into ${banned}`);
    }
  }
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(`${rootAbs}/`)) {
    throw new Error(`spawn files must stay under ${rootAbs}`);
  }
}
