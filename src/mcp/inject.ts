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
}): SpawnInject {
  const token = opts.token ?? "";
  const mcpUrl = opts.mcpUrl ?? `http://127.0.0.1:${opts.cfg.port}/mcp`;
  const vars = spawnVars(opts.cfg, opts.session, {
    NCLI_TICKET: opts.ticket ?? "",
    NCLI_MCP_TOKEN: token,
    NCLI_MCP_URL: mcpUrl,
  });
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
    token,
    mcpUrl,
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
    if (s.type === "http" && s.url) {
      out.push("-c", `mcp_servers.${s.name}.url=${s.url}`);
      for (const [k, v] of Object.entries(s.headers ?? {})) {
        if (!v) continue;
        out.push("-c", `mcp_servers.${s.name}.http_headers.${k}=${v}`);
      }
      continue;
    }
    out.push("-c", `mcp_servers.${s.name}.command=${s.command ?? "bun"}`);
    out.push("-c", `mcp_servers.${s.name}.args=${JSON.stringify(s.args ?? [])}`);
    for (const [k, v] of Object.entries(s.env ?? {})) {
      if (!v) continue;
      out.push("-c", `mcp_servers.${s.name}.env.${k}=${v}`);
    }
  }
  return out;
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
  return `NCLI skills, pstack, and emil live in ${skillsDir}.
Read ncli/skills/<id>/SKILL.md for NCLI flows.
Read ncli/skills/pstack/poteto-mode/SKILL.md for pstack.
Read ncli/skills/emil/emil-design-eng/SKILL.md for UI craft.
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
