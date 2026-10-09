import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config";
import { bootNcli } from "../src/boot";
import { asClaudeMap, prepareSpawn } from "../src/mcp/inject";
import { NCLI_TOOLS } from "../src/mcp/tools";
import { makeHub, tmpDir } from "./helpers";

async function mcp(url: string, token: string, method: string, params?: Record<string, unknown>, id: number | string = 1) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return res.json() as Promise<{ result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> }; error?: { message: string } }>;
}

test("Streamable HTTP MCP lists and calls ncli tools with a spawn token", async () => {
  const { hub } = await makeHub();
  hub.cfg.port = 19000 + Math.floor(Math.random() * 1000);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  try {
    const inj = hub.injectSpawn("main", "claude");
    const json = JSON.parse(readFileSync(inj.mcpConfigPath, "utf8")) as {
      mcpServers: { ncli: { type: string; url: string; headers: { Authorization: string } } };
    };
    expect(json.mcpServers.ncli.type).toBe("http");
    expect(json.mcpServers.ncli.url).toBe(booted.report.mcpUrl);
    expect(json.mcpServers.ncli.headers.Authorization).toStartWith("Bearer ");

    const denied = await fetch(booted.report.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(denied.status).toBe(401);

    const token = json.mcpServers.ncli.headers.Authorization.slice("Bearer ".length);
    const listed = await mcp(booted.report.mcpUrl, token, "tools/list");
    const names = (listed.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("ask");
    expect(names).toContain("zoom");
    expect(names).toContain("switch_harness");
    expect(names.length).toBe(NCLI_TOOLS.length);

    const views = await mcp(booted.report.mcpUrl, token, "tools/call", { name: "list_views", arguments: {} });
    expect(views.result?.content?.[0]?.text).toContain("review");

    const switched = await mcp(booted.report.mcpUrl, token, "tools/call", {
      name: "switch_harness",
      arguments: { harness: "codex" },
    });
    expect(switched.result?.content?.[0]?.text).toContain("codex");
    expect(hub.harness.id).toBe("codex");
  } finally {
    booted.stop();
  }
});

test("legacy initialize without protocolVersion still returns serverInfo ncli", async () => {
  const { hub } = await makeHub();
  hub.cfg.port = 19100 + Math.floor(Math.random() * 1000);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  try {
    const token = hub.mcp.mint("main");
    const json = await mcp(booted.report.mcpUrl, token, "initialize", {});
    expect(json.result).toBeDefined();
  } finally {
    booted.stop();
  }
});

test("prepareSpawn writes type http for Cursor and Claude, never a bun shim", () => {
  const cfg = loadConfig({ dataDir: tmpDir("http-inj"), ncliRoot: process.cwd(), port: 47231 });
  const inj = prepareSpawn({ cfg, session: "main", harness: "claude", token: "tok", mcpUrl: "http://127.0.0.1:47231/mcp" });
  const map = asClaudeMap(inj.mcpServers);
  expect(map.ncli).toEqual({
    type: "http",
    url: "http://127.0.0.1:47231/mcp",
    headers: { Authorization: "Bearer tok" },
  });
});
