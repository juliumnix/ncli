import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { NcliConfig } from "../config";
import { defaultSkillsDir } from "../skills/catalog";
import { loadMcpRegistry, resolveServers, spawnVars, type McpServerSpec } from "./registry";

export interface SpawnInject {
  dir: string;
  mcpConfigPath: string;
  extraArgs: string[];
  mcpServers: McpServerSpec[];
  addDir: string[];
  agentsMd: string;
}

export function prepareSpawn(opts: {
  cfg: NcliConfig;
  session: string;
  harness: string;
  worktree?: string;
  ticket?: string;
}): SpawnInject {
  const vars = spawnVars(opts.cfg, opts.session, opts.ticket ? { NCLI_TICKET: opts.ticket } : {});
  const servers = resolveServers(loadMcpRegistry(opts.cfg.ncliRoot), vars);
  const dir = join(opts.cfg.dataDir, "spawn", opts.session.replace(/[^a-zA-Z0-9._-]/g, "_"));
  assertLocal(dir, opts.cfg.dataDir);
  mkdirSync(dir, { recursive: true });
  const mcpConfigPath = join(dir, "mcp.json");
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: asClaudeMap(servers) }, null, 2), "utf8");
  const skills = defaultSkillsDir(opts.cfg.ncliRoot);
  const agentsMd = agentsBlock(skills);
  writeFileSync(join(dir, "AGENTS.md"), agentsMd, "utf8");
  const extraArgs = extraFor(opts.harness, servers, skills);
  maybeWriteCursorWorkspace(opts.worktree, opts.cfg, servers, agentsMd);
  return {
    dir,
    mcpConfigPath,
    extraArgs,
    mcpServers: servers,
    addDir: [skills],
    agentsMd,
  };
}

export function extraFor(harness: string, servers: McpServerSpec[], skillsDir: string): string[] {
  switch (harness) {
    case "claude":
      return ["--add-dir", skillsDir];
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
    out.push("-c", `mcp_servers.${s.name}.command=${s.command}`);
    out.push("-c", `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`);
    for (const [k, v] of Object.entries(s.env)) {
      if (!v) continue;
      out.push("-c", `mcp_servers.${s.name}.env.${k}=${v}`);
    }
  }
  return out;
}

export function asClaudeMap(servers: McpServerSpec[]): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  const map: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  for (const s of servers) map[s.name] = { command: s.command, args: s.args, env: s.env };
  return map;
}

function agentsBlock(skillsDir: string): string {
  return `NCLI skills and pstack live in ${skillsDir}.
Read ncli/skills/<id>/SKILL.md for NCLI flows.
Read ncli/skills/pstack/poteto-mode/SKILL.md for pstack.
MCP tools come from the ncli server injected for this spawn only.
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
