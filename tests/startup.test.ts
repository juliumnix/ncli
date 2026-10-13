import { expect, test } from "bun:test";
import { DEFAULT_COMPACT_MODEL, loadConfig, parseCompactModel, parseUserName } from "../src/config";
import { bootNcli, bootVerbose, formatBoot, shouldValidateCompactModel } from "../src/boot";
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
    expect(booted.report.compact.model).toBe(DEFAULT_COMPACT_MODEL);
    expect(booted.report.views).toContain("review");
    const summary = formatBoot(booted.report);
    expect(summary).toContain("NCLI rodando em");
    expect(summary).toContain(booted.report.uiUrl.replace("127.0.0.1", "localhost"));
    expect(summary).toContain("clis");
    expect(summary).toContain(booted.report.revision);
    expect(summary).not.toContain("compact:");
    expect(summary).not.toContain("mcp");
    expect(booted.report.revision.length).toBeGreaterThanOrEqual(7);
    expect(formatBoot(booted.report, { verbose: true })).toContain(DEFAULT_COMPACT_MODEL);

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

test("boot banner is URL, CLIs and version; compact and cli-config stay in verbose", () => {
  const report = {
    uiUrl: "http://127.0.0.1:47231",
    mcpUrl: "http://127.0.0.1:47231/mcp",
    main: { harness: "claude", model: "opus" },
    compact: { backend: "cursor", model: DEFAULT_COMPACT_MODEL, budget: 250000, sdk: "ok" as const },
    warning: "NCLI will not rewrite your Cursor CLI config.",
    clis: { claude: true, codex: false, cursor: true },
    bus: "/tmp/ncli-bus.sock",
    views: ["review"],
    liveOrigin: "http://127.0.0.1:9",
    revision: "b5f42a6",
  };
  const text = formatBoot(report);
  expect(text).toBe("NCLI rodando em http://localhost:47231 · b5f42a6\nclis  claude ok, codex missing, cursor ok");
  expect(text).not.toContain("compact:");
  expect(text).not.toContain("cli-config");
  expect((text.match(/clis/g) || []).length).toBe(1);
  const verbose = formatBoot(report, { verbose: true });
  expect(verbose).toContain("agent claude · opus");
  expect(verbose).toContain("compact: cursor-sdk ok");
  expect(verbose).toContain(DEFAULT_COMPACT_MODEL);
  expect(verbose).toContain("Cursor CLI config");
  expect(formatBoot({ ...report, revision: "" })).toBe(
    "NCLI rodando em http://localhost:47231\nclis  claude ok, codex missing, cursor ok",
  );
});

test("loadConfig keeps Composer 2.5 as the compact default and a 60k input cap", () => {
  const cfg = loadConfig({ dataDir: tmpDir("cfg") });
  expect(cfg.compactModel).toBe("composer-2.5");
  expect(cfg.compactMaxInputTokens).toBe(60_000);
  expect(cfg.compactSettleMs).toBe(0);
  expect(cfg.compactTimeoutMs).toBe(120_000);
  expect(cfg.compactBatch).toBe(200);
  expect(cfg.compactJobs).toBe(6);
  expect(cfg.cursorModel).toBe("composer-2.5");
  expect(cfg.codexModel).toBe("");
});

test("bootVerbose is NCLI_VERBOSE or --verbose", () => {
  expect(bootVerbose({}, [])).toBe(false);
  expect(bootVerbose({ NCLI_VERBOSE: "1" }, [])).toBe(true);
  expect(bootVerbose({}, ["bun", "src/index.ts", "--verbose"])).toBe(true);
});

test("parseCompactModel defaults to Composer 2.5 and keeps an env-style override", () => {
  expect(parseCompactModel(undefined)).toBe("composer-2.5");
  expect(parseCompactModel("")).toBe("composer-2.5");
  expect(parseCompactModel("   ")).toBe("composer-2.5");
  expect(parseCompactModel(" claude-haiku-5-5 ")).toBe("claude-haiku-5-5");
  expect(loadConfig({ compactModel: "claude-haiku-5-5" }).compactModel).toBe("claude-haiku-5-5");
  expect(loadConfig({ compactModel: "  " }).compactModel).toBe("composer-2.5");
});

test("mock compact skips the live Cursor.models.list check", () => {
  expect(shouldValidateCompactModel(loadConfig({ harness: "mock", compactBackend: "auto" }))).toBe(false);
  expect(shouldValidateCompactModel(loadConfig({ harness: "claude", compactBackend: "cursor" }))).toBe(true);
});

test("parseUserName reads NCLI_USER_NAME and falls back to Você", () => {
  expect(parseUserName(undefined)).toBe("Você");
  expect(parseUserName("")).toBe("Você");
  expect(parseUserName("   ")).toBe("Você");
  expect(parseUserName(" Ana ")).toBe("Ana");
  expect(loadConfig({ userName: "Maria" }).userName).toBe("Maria");
  expect(loadConfig({ userName: "  " }).userName).toBe("Você");
});
