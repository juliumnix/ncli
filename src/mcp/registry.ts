import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NcliConfig } from "../config";
import { defaultSkillsDir } from "../skills/catalog";

export type McpTransport = "stdio" | "http";

export interface McpServerSpec {
  name: string;
  type: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
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
    mcpServers?: Record<string, {
      type?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
    }>;
  };
  const servers: McpServerSpec[] = [];
  for (const [name, spec] of Object.entries(raw.mcpServers ?? {})) {
    const type: McpTransport = spec.type === "http" || spec.url ? "http" : "stdio";
    servers.push({
      name,
      type,
      command: spec.command,
      args: spec.args ?? [],
      env: spec.env ?? {},
      url: spec.url,
      headers: spec.headers ?? {},
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
    type: s.type,
    command: s.command ? subst(s.command, vars) : undefined,
    args: (s.args ?? []).map((a) => subst(a, vars)),
    env: Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, subst(v, vars)])),
    url: s.url ? subst(s.url, vars) : undefined,
    headers: Object.fromEntries(Object.entries(s.headers ?? {}).map(([k, v]) => [k, subst(v, vars)])),
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
    NCLI_MCP_URL: extra.NCLI_MCP_URL ?? `http://127.0.0.1:${cfg.port}/mcp`,
    NCLI_MCP_TOKEN: extra.NCLI_MCP_TOKEN ?? "",
    ...extra,
  };
}

function subst(s: string, vars: Record<string, string>): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => vars[k] ?? "");
}
