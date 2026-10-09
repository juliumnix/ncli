import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { bootNcli, formatBoot } from "../src/boot";
import { makeHub, tmpDir } from "./helpers";

test("bun start boots HTTP, SSE, MCP and bus in one process and fails loud if MCP is down", async () => {
  const { hub } = await makeHub();
  hub.cfg.port = 18000 + Math.floor(Math.random() * 1000);
  const booted = await bootNcli({
    cfg: hub.cfg,
    hub,
    root: process.cwd(),
  });
  try {
    expect(booted.report.uiUrl).toStartWith("http://127.0.0.1:");
    expect(booted.report.mcpUrl).toBe(`${booted.report.uiUrl}/mcp`);
    expect(booted.report.main.harness).toBe("mock");
    expect(booted.report.compact.model).toBe("claude-haiku-5-5-low");
    expect(booted.report.views).toContain("review");
    const summary = formatBoot(booted.report);
    expect(summary).toContain("NCLI");
    expect(summary).toContain(booted.report.uiUrl);
    expect(summary).toContain("mcp");
    expect(summary).toContain("claude-haiku-5-5-low");

    const token = hub.mcp.mint("main");
    const init = await fetch(booted.report.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
    });
    const initJson = await init.json() as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(initJson.result.serverInfo.name).toBe("ncli");
    expect(initJson.result.protocolVersion).toBe("2024-11-05");

    const fav = await fetch(`${booted.report.uiUrl}/favicon.ico`);
    expect(fav.ok).toBe(true);

    const events = await fetch(`${booted.report.uiUrl}/api/events`);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    events.body?.cancel();
  } finally {
    booted.stop();
  }
});

test("boot report mentions the main agent and compact model", () => {
  const text = formatBoot({
    uiUrl: "http://127.0.0.1:47231",
    mcpUrl: "http://127.0.0.1:47231/mcp",
    main: { harness: "claude", model: "opus" },
    compact: { backend: "cursor", model: "claude-haiku-5-5-low", budget: 250000 },
    clis: { claude: true, codex: false, cursor: true },
    bus: "/tmp/ncli-bus.sock",
    views: ["review"],
  });
  expect(text).toContain("agent claude · opus");
  expect(text).toContain("claude-haiku-5-5-low");
  expect(text).toContain("cursor ok");
});

test("loadConfig keeps Haiku 5.5 as the cheap compact default and a 60k input cap", () => {
  const cfg = loadConfig({ dataDir: tmpDir("cfg") });
  expect(cfg.compactModel).toBe("claude-haiku-5-5-low");
  expect(cfg.compactMaxInputTokens).toBe(60_000);
});
