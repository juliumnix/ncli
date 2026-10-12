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
import { detectClis, type CliPresence } from "./ui/chrome";
import { startLiveOrigin } from "./live/origin";
import { announceReady, formatClis, openReadyBrowser, readyUrl } from "./boot-ready";
import { busyPortMessage, isAddrInUse, nextPorts, portPinned } from "./listen-port";
import { resolveRevision } from "./revision";
export { detectClis };

export interface BootReport {
  uiUrl: string;
  mcpUrl: string;
  main: { harness: string; model?: string };
  compact: { backend: string; model: string; budget: number; sdk: "ok" | "missing-key" };
  warning?: string;
  clis: CliPresence;
  bus: string;
  views: string[];
  liveOrigin: string;
  revision: string;
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

export function bootVerbose(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  const v = (env.NCLI_VERBOSE ?? "").trim();
  if (v === "1" || v.toLowerCase() === "true") return true;
  return argv.includes("--verbose");
}

export function formatBoot(r: BootReport, opts: { verbose?: boolean } = {}): string {
  const url = r.uiUrl.replace("127.0.0.1", "localhost");
  const rev = r.revision ? ` · ${r.revision}` : "";
  const short = [`NCLI rodando em ${url}${rev}`, formatClis(r.clis)].join("\n");
  if (!opts.verbose) return short;
  return [
    short,
    `agent ${r.main.harness}${r.main.model ? ` · ${r.main.model}` : ""}`,
    `mcp   ${r.mcpUrl}  (listening)`,
    `bus   ${r.bus}`,
    `compact: cursor-sdk ${r.compact.sdk} · ${r.compact.model} · budget ${r.compact.budget}`,
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
  openBrowser?: boolean;
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
  const publicDir = opts.publicDir ?? join(root, "public");
  const live = startLiveOrigin({ port: cfg.livePort, publicDir });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = listenUi(hub, cfg, publicDir);
  } catch (err) {
    live.stop();
    hub.close();
    if (err instanceof Error && err.message.startsWith("A porta ")) throw err;
    throw new Error(`HTTP UI failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
  hub.offerFirstImport();
  hub.mcpUrl = `http://127.0.0.1:${server.port}/mcp`;
  const clis = detectClis(cfg);
  const revision = resolveRevision(root);
  announceReady({ url: readyUrl(server.port), clis, revision: revision.short });
  if (opts.openBrowser) {
    openReadyBrowser({ url: readyUrl(server.port), dataDir: cfg.dataDir });
  }
  const token = hub.mcp.mint("boot");
  try {
    await assertMcp(hub.mcpUrl, token);
  } catch (err) {
    live.stop();
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
    clis,
    bus: hub.bus.socketPath,
    views: hub.views.list().map((v) => v.id),
    liveOrigin: live.origin,
    revision: revision.short,
  };
  return {
    hub,
    server,
    report,
    stop() {
      live.stop();
      server.stop(true);
      hub.close();
    },
  };
}

function listenUi(hub: Hub, cfg: NcliConfig, publicDir: string): ReturnType<typeof Bun.serve> {
  const pinned = portPinned();
  const ports = pinned ? [cfg.port] : nextPorts(cfg.port);
  let last: unknown;
  for (const port of ports) {
    try {
      cfg.port = port;
      return serve(hub, cfg, publicDir);
    } catch (err) {
      last = err;
      if (!isAddrInUse(err)) throw err;
      if (pinned) throw new Error(busyPortMessage(port));
    }
  }
  throw new Error(busyPortMessage(ports.at(-1) ?? cfg.port));
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
