import { expect, test } from "bun:test";
import { cursorAcpServers, cursorAcpSpawn } from "../src/acp/cursor";
import { formatRpcError } from "../src/acp/error";
import { NdjsonRpc } from "../src/acp/rpc";
import { bootNcli } from "../src/boot";
import { loadConfig } from "../src/config";
import { prepareSpawn } from "../src/mcp/inject";
import { makeHub, tmpDir } from "./helpers";

test("ask/wait through the ncli MCP reaches a mock seat with HTTP MCP injected", async () => {
  const { hub } = await makeHub();
  hub.cfg.port = 19400 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  try {
    const inj = hub.injectSpawn("bus-ask", "cursor");
    expect(inj.mcpServers[0]?.type).toBe("http");
    expect(inj.mcpServers[0]?.url).toBe(booted.report.mcpUrl);
    const got = hub.bus.ask("main", "codex", "reply with only pong");
    if ("error" in got) throw new Error(got.error);
    const tickets = await hub.bus.wait(got.ticket, 5000);
    expect(tickets[0]?.status).toBe("done");
    expect(tickets[0]?.result).toContain("pong");
  } finally {
    booted.stop();
  }
});

test("real cursor-agent acp accepts HTTP ncli MCP on session/new when the binary exists", async () => {
  const cfg = loadConfig({ dataDir: tmpDir("cur-acp"), acpCursor: "cursor-agent acp" });
  const spawn = cursorAcpSpawn(cfg);
  if (!Bun.which(spawn.command)) return;
  const { hub } = await makeHub();
  hub.cfg.port = 19500 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const inj = prepareSpawn({
    cfg: { ...hub.cfg, ncliRoot: process.cwd() },
    session: "cursor-live",
    harness: "cursor",
    token: hub.mcp.mint("cursor-live"),
    mcpUrl: booted.report.mcpUrl,
  });
  const proc = Bun.spawn([spawn.command, ...spawn.args], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const rpc = new NdjsonRpc(proc.stdin, proc.stdout);
  try {
    await Promise.race([
      rpc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: "ncli-test", version: "0.2.0" },
      }),
      Bun.sleep(8000).then(() => {
        throw new Error("cursor-agent initialize timeout");
      }),
    ]);
    const session = await Promise.race([
      rpc.request("session/new", {
        cwd: process.cwd(),
        mcpServers: cursorAcpServers(inj.mcpServers),
      }),
      Bun.sleep(8000).then(() => {
        throw new Error("cursor-agent session/new timeout");
      }),
    ]);
    expect((session as { sessionId?: string }).sessionId).toBeTruthy();
  } catch (err) {
    const msg = formatRpcError(err).message;
    expect(msg).not.toContain("[object Object]");
    expect(msg).not.toMatch(/-32603/);
    if (/authenticate|login|auth|unauthorized/i.test(msg) || msg.includes("timeout")) return;
    throw err;
  } finally {
    rpc.close();
    proc.kill();
    booted.stop();
  }
});

test("real codex exec answers when the binary exists", async () => {
  if (!Bun.which("codex")) return;
  const { hub } = await makeHub();
  try {
    const got = hub.bus.ask("main", "codex", "reply with only pong");
    if ("error" in got) throw new Error(got.error);
    const tickets = await hub.bus.wait(got.ticket, 15_000);
    if (tickets[0]?.status === "error") {
      const err = tickets[0].error ?? "";
      if (/not found|ENOENT|login|auth/i.test(err)) return;
      throw new Error(err);
    }
    expect(tickets[0]?.result ?? "").toMatch(/pong/i);
  } finally {
    hub.close();
  }
});
