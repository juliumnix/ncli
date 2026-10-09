import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NcliConfig } from "../config";
import { defaultSkillsDir } from "../skills/catalog";

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpRegistry {
  servers: McpServerSpec[];
  path: string;
}

export function defaultMcpRegistryPath(ncliRoot: string): string {
  return join(ncliRoot, "ncli/mcp.json");
}

export function loadMcpRegistry(ncliRoot: string): McpRegistry {
  const path = defaultMcpRegistryPath(ncliRoot);
  if (!existsSync(path)) return { servers: [], path };
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  const servers: McpServerSpec[] = [];
  for (const [name, spec] of Object.entries(raw.mcpServers ?? {})) {
    servers.push({
      name,
      command: spec.command ?? "bun",
      args: spec.args ?? [],
      env: spec.env ?? {},
    });
  }
  return { servers, path };
}

export function resolveServers(
  registry: McpRegistry,
  vars: Record<string, string>,
): McpServerSpec[] {
  return registry.servers.map((s) => ({
    name: s.name,
    command: subst(s.command, vars),
    args: s.args.map((a) => subst(a, vars)),
    env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, subst(v, vars)])),
  }));
}

export function spawnVars(
  cfg: NcliConfig,
  session: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const bin = process.execPath.includes("bun") ? "bun" : process.execPath;
  return {
    NCLI_BIN: bin,
    NCLI_ROOT: cfg.ncliRoot,
    NCLI_DATA: cfg.dataDir,
    NCLI_SESSION: session,
    NCLI_BUS_SOCK: join(cfg.dataDir, "ncli-bus.sock"),
    NCLI_TICKET: extra.NCLI_TICKET ?? "",
    NCLI_SKILLS: defaultSkillsDir(cfg.ncliRoot),
    ...extra,
  };
}

function subst(s: string, vars: Record<string, string>): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => vars[k] ?? "");
}
