import { homedir } from "node:os";
import { join } from "node:path";
import type { NcliConfig } from "./config";
import { loadConfig } from "./config";
import { Hub } from "./hub";
import { serve } from "./server";
import { MCP_PROTOCOL_DEFAULT } from "./mcp/handle";
import { cursorCliConfigPath, cursorPollutionWarning } from "./memory/cli-config";
import { assertCompactModel } from "./memory/compact-model";
import { compactSdkStatus } from "./memory/sdk-compact";
import { compactSdkKey, loadNcliSecrets } from "./secrets";

export interface CliPresence {
  claude: boolean;
  codex: boolean;
  cursor: boolean;
}

export interface BootReport {
  uiUrl: string;
  mcpUrl: string;
  main: { harness: string; model?: string };
  compact: { backend: string; model: string; budget: number; sdk: "ok" | "missing-key" };
  warning?: string;
  clis: CliPresence;
  bus: string;
  views: string[];
}

export interface Booted {
  hub: Hub;
  server: ReturnType<typeof Bun.serve>;
  report: BootReport;
  stop(): void;
}

export function shouldValidateCompactModel(cfg: NcliConfig): boolean {
  if (cfg.compactBackend === "mock") return false;
  if (cfg.compactBackend === "auto" && cfg.harness === "mock") return false;
  return true;
}

export function detectClis(cfg: NcliConfig): CliPresence {
  return {
    claude: Boolean(Bun.which(cfg.claudeBin)),
    codex: Boolean(Bun.which(cfg.codexBin)),
    cursor: Boolean(Bun.which(cfg.cursorBin)),
  };
}

export function formatBoot(r: BootReport): string {
  const cli = [
    `claude ${r.clis.claude ? r.main.harness === "claude" ? "ok (main)" : "ok" : "missing"}`,
    `codex ${r.clis.codex ? r.main.harness === "codex" ? "ok (main)" : "ok" : "missing"}`,
    `cursor ${r.clis.cursor ? r.main.harness === "cursor" ? "ok (main)" : "ok" : "missing"}`,
  ].join(", ");
  return [
    `NCLI  ${r.uiUrl}`,
    `agent ${r.main.harness}${r.main.model ? ` · ${r.main.model}` : ""}`,
    `mcp   ${r.mcpUrl}  (listening)`,
    `bus   ${r.bus}`,
    `compact: cursor-sdk ${r.compact.sdk} · ${r.compact.model} · budget ${r.compact.budget}`,
    `clis  ${cli}`,
    `views ${r.views.join(", ") || "(none)"}`,
    r.warning,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function bootNcli(opts: {
  cfg?: NcliConfig;
  root?: string;
  publicDir?: string;
  hub?: Hub;
} = {}): Promise<Booted> {
  const root = opts.root ?? join(import.meta.dir, "..");
  loadNcliSecrets();
  const cfg = opts.cfg ?? loadConfig();
  if (shouldValidateCompactModel(cfg) && compactSdkKey()) {
    await assertCompactModel(cfg.compactModel);
  }
  const hub = opts.hub ?? new Hub(cfg, join(root, "views"), join(root, "fixtures/gh"));
  try {
    await hub.start();
  } catch (err) {
    throw new Error(`ncli-bus failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!hub.bus.socketPath) throw new Error("ncli-bus failed to start: no socket path");
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = serve(hub, cfg, opts.publicDir ?? join(root, "public"));
  } catch (err) {
    hub.close();
    throw new Error(`HTTP UI failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
  hub.mcpUrl = `http://127.0.0.1:${server.port}/mcp`;
  const token = hub.mcp.mint("boot");
  try {
    await assertMcp(hub.mcpUrl, token);
  } catch (err) {
    server.stop(true);
    hub.close();
    throw err;
  }
  const main = hub.mainAgent();
  const report: BootReport = {
    uiUrl: `http://127.0.0.1:${server.port}`,
    mcpUrl: hub.mcpUrl,
    main: { harness: main.harness, model: main.model },
    compact: {
      backend: cfg.compactBackend,
      model: cfg.compactModel,
      budget: cfg.compactBudgetTokens,
      sdk: compactSdkStatus(),
    },
    warning: cursorPollutionWarning({
      cliConfigPath: cursorCliConfigPath(homedir()),
      compactModel: cfg.compactModel,
    }) ?? undefined,
    clis: detectClis(cfg),
    bus: hub.bus.socketPath,
    views: hub.views.list().map((v) => v.id),
  };
  return {
    hub,
    server,
    report,
    stop() {
      server.stop(true);
      hub.close();
    },
  };
}

async function assertMcp(url: string, token: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_DEFAULT, capabilities: {}, clientInfo: { name: "ncli-boot", version: "0" } },
      }),
    });
  } catch (err) {
    throw new Error(`ncli MCP failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`ncli MCP failed to start: HTTP ${res.status}`);
  const json = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
  if (json.result?.serverInfo?.name !== "ncli") {
    throw new Error(`ncli MCP failed to start: unexpected initialize ${JSON.stringify(json)}`);
  }
}
