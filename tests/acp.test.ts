import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { buildClaudeArgs, parseClaudeLine, resolveClaudeSession } from "../src/acp/claude";
import { buildCodexArgs, parseCodexLine } from "../src/acp/codex";
import { cursorAcpServers, cursorAcpSpawn, cursorUpdate } from "../src/acp/cursor";
import { formatRpcError } from "../src/acp/error";
import { MockAcpAdapter } from "../src/acp/mock";
import { NdjsonRpc } from "../src/acp/rpc";
import { toHarnessEvents } from "../src/acp/map";
import { AcpHarness } from "../src/harness/acp";
import { childEnv } from "../src/harness/child-env";
import { tmpDir } from "./helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

test("claude -p is the primary path: stream-json, model, mcp, system-prompt-file, UUID session", () => {
  const dataDir = tmpDir("acp-claude");
  const cfg = loadConfig({ dataDir, claudeBin: "claude", claudeModel: "sonnet" });
  const args = buildClaudeArgs(cfg, {
    prompt: "confirma o desconto",
    system: "You are NCLI.",
    mcpConfigPath: "/tmp/mcp.json",
    session: "main",
  });
  expect(args.slice(0, 5)).toEqual(["claude", "-p", "--output-format", "stream-json", "--verbose"]);
  expect(args).toContain("--model");
  expect(args).toContain("sonnet");
  expect(args).toContain("--mcp-config");
  expect(args).toContain("/tmp/mcp.json");
  expect(args).toContain("--strict-mcp-config");
  expect(args).toContain("--session-id");
  const sid = args[args.indexOf("--session-id") + 1];
  expect(sid).toMatch(UUID);
  expect(args).not.toContain("main");
  const sp = args[args.indexOf("--system-prompt-file") + 1];
  expect(existsSync(sp)).toBe(true);
  expect(readFileSync(sp, "utf8")).toContain("You are NCLI.");
  expect(args.at(-1)).toBe("confirma o desconto");
});

test("a second claude turn on the same NCLI session uses --resume with the same UUID", () => {
  const dataDir = tmpDir("acp-resume");
  const cfg = loadConfig({ dataDir, claudeBin: "claude" });
  const first = buildClaudeArgs(cfg, { prompt: "oi", session: "main" });
  const second = buildClaudeArgs(cfg, { prompt: "e o PDF?", session: "main" });
  const id = first[first.indexOf("--session-id") + 1];
  expect(second).toContain("--resume");
  expect(second).not.toContain("--session-id");
  expect(second[second.indexOf("--resume") + 1]).toBe(id);
  expect(resolveClaudeSession(dataDir, "main").id).toBe(id);
});

test("parseClaudeLine maps stream-json assistant/tool events and ignores the trailing result", () => {
  const text = parseClaudeLine(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Desconto antes do imposto." }] } }),
  );
  expect(text).toEqual([{ sessionUpdate: "agent_message_chunk", text: "Desconto antes do imposto." }]);
  const tool = parseClaudeLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
    }),
  );
  expect(tool).toEqual([
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "Bash", rawInput: { command: "ls" } },
  ]);
  const result = parseClaudeLine(
    JSON.stringify({ type: "result", result: "Desconto antes do imposto.", is_error: false }),
  );
  expect(result).toEqual([]);
  expect(parseClaudeLine("not-json")).toEqual([]);
});

test("childEnv strips Anthropic/Claude tokens and never keeps OAuth, even when the API key is opted in", () => {
  const parent = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
    CLAUDE_CODE_CREDENTIALS: "creds",
    ANTHROPIC_AUTH_TOKEN: "other",
    HOME: "/home/ada",
    CURSOR_API_KEY: "cursor-secret",
    CURSOR_AUTH_TOKEN: "auth-secret",
    NCLI_CURSOR_API_KEY: "ncli-compact-secret",
  };
  const stripped = childEnv(parent);
  expect(stripped.PATH).toBe("/usr/bin");
  expect(stripped.HOME).toBe("/home/ada");
  expect(stripped.ANTHROPIC_API_KEY).toBeUndefined();
  expect(stripped.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(stripped.CLAUDE_CODE_CREDENTIALS).toBeUndefined();
  expect(stripped.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(stripped.CURSOR_API_KEY).toBeUndefined();
  expect(stripped.CURSOR_AUTH_TOKEN).toBeUndefined();
  expect(stripped.NCLI_CURSOR_API_KEY).toBeUndefined();
  const opted = childEnv(parent, { allowAnthropicKey: true });
  expect(opted.ANTHROPIC_API_KEY).toBe("sk-secret");
  expect(opted.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(opted.NCLI_CURSOR_API_KEY).toBeUndefined();
});

test("MockAcpAdapter through AcpHarness yields text, tools, plan, and permission as harness events", async () => {
  const adapter = new MockAcpAdapter(() => ({
    plan: ["Ler o diff", "Escrever o teste"],
    permission: { id: "p1", title: "edit config" },
    tools: [{ id: "bash-1", title: "Bash", command: "ls" }],
    chunks: ["ok ", "feito."],
  }));
  const events = await collect(new AcpHarness(adapter).run({ prompt: "plano" }));
  expect(events).toContainEqual({ type: "tool", name: "plan", input: { entries: ["Ler o diff", "Escrever o teste"] }, id: "plan" });
  expect(events).toContainEqual({ type: "tool", name: "permission", input: { title: "edit config" }, id: "p1" });
  expect(events).toContainEqual({ type: "tool", name: "Bash", input: { command: "ls" }, id: "bash-1", seat: "claude" });
  expect(events).toContainEqual({ type: "tool_result", id: "bash-1", content: "ok" });
  expect(events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : ""))).toEqual(["ok ", "feito."]);
  expect(events.at(-1)).toEqual({ type: "done", text: "ok feito." });
});

test("toHarnessEvents maps ACP chunks without spawning a real CLI", async () => {
  async function* updates() {
    yield { sessionUpdate: "agent_message_chunk" as const, text: "olá" };
  }
  const events = await collect(toHarnessEvents(updates(), { prompt: "x" }));
  expect(events).toEqual([{ type: "text", text: "olá", seat: "claude" }]);
});

test("codex exec pins NCLI_CODEX_MODEL and never relies on a saved default", () => {
  const cfg = loadConfig({ codexBin: "codex", codexModel: "gpt-5.4" });
  const args = buildCodexArgs(cfg, { prompt: "confirma" });
  expect(args.slice(0, 5)).toEqual(["codex", "exec", "--json", "--model", "gpt-5.4"]);
  expect(args.at(-1)).toBe("confirma");
});

test("parseCodexLine maps exec --json message and tool events", () => {
  expect(parseCodexLine(JSON.stringify({ type: "item.completed", item: { text: "bate." } }))).toEqual([
    { sessionUpdate: "agent_message_chunk", text: "bate." },
  ]);
  const tool = parseCodexLine(JSON.stringify({ type: "tool_call", item: { id: "c1", name: "shell", command: "rg" } }));
  expect(tool[0]?.sessionUpdate).toBe("tool_call");
});

test("cursor first-party ACP spawn is cursor-agent acp, and session/update maps in-process", () => {
  const cfg = loadConfig({ acpCursor: "cursor-agent acp" });
  expect(cursorAcpSpawn(cfg)).toEqual({ command: "cursor-agent", args: ["--model", "composer-2.5", "acp"] });
  expect(
    cursorUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Confirmo." },
    }),
  ).toEqual([{ sessionUpdate: "agent_message_chunk", text: "Confirmo." }]);
  expect(
    cursorUpdate({ sessionUpdate: "tool_call", toolCallId: "t", title: "Read", rawInput: { path: "a.ts" } }),
  ).toEqual([{ sessionUpdate: "tool_call", toolCallId: "t", title: "Read", rawInput: { path: "a.ts" } }]);
  expect(cursorUpdate({ sessionUpdate: "plan", entries: [{ content: "a" }, { content: "b" }] })).toEqual([
    { sessionUpdate: "plan", entries: ["a", "b"] },
  ]);
});

test("package.json has no Agent SDK, ACP SDK, or third-party Claude ACP adapter", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  expect(Object.keys(pkg.devDependencies ?? {})).toEqual([]);
  const deps = Object.keys(pkg.dependencies ?? {});
  expect(deps.every((name) => name === "@cursor/sdk")).toBe(true);
  const blob = JSON.stringify(pkg);
  expect(blob).not.toContain("claude-agent-sdk");
  expect(blob).not.toContain("claude-code-acp");
  expect(blob).not.toContain("agentclientprotocol");
  expect(blob).not.toContain("harukitosa");
});

test("NdjsonRpc speaks JSON-RPC ndjson over a fake stdio pair", async () => {
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const written: string[] = [];
  const rpc = new NdjsonRpc(
    {
      write(data) {
        written.push(data);
        return data.length;
      },
      end() {
        controller.close();
      },
    },
    stdout,
  );
  const pending = rpc.request("initialize", { protocolVersion: 1 });
  expect(JSON.parse(written[0]!)).toEqual({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  controller.enqueue(enc.encode(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n`));
  expect(await pending).toEqual({ ok: true });
  rpc.close();
});

test("cursor session/new MCP servers keep HTTP type/url/headers and env as name/value pairs", () => {
  expect(
    cursorAcpServers([
      {
        name: "ncli",
        type: "http",
        url: "http://127.0.0.1:47231/mcp",
        headers: { Authorization: "Bearer tok" },
        env: { FOO: "bar" },
      },
      { name: "stdio", command: "bun", args: ["run", "x"], env: { A: "1" } },
    ]),
  ).toEqual([
    {
      type: "http",
      name: "ncli",
      url: "http://127.0.0.1:47231/mcp",
      headers: [{ name: "Authorization", value: "Bearer tok" }],
    },
    {
      type: "stdio",
      name: "stdio",
      command: "bun",
      args: ["run", "x"],
      env: [{ name: "A", value: "1" }],
    },
  ]);
});

test("JSON-RPC errors become a readable Error, not [object Object]", async () => {
  expect(formatRpcError({ code: -32603, message: "Invalid input", data: { path: "mcpServers.0" } }).message).toContain(
    "Invalid input",
  );
  expect(formatRpcError({ code: -32603, message: "Invalid input" }).message).not.toBe("[object Object]");

  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const rpc = new NdjsonRpc(
    {
      write() {
        return 0;
      },
      end() {
        controller.close();
      },
    },
    stdout,
  );
  const pending = rpc.request("session/new", {});
  controller.enqueue(
    enc.encode(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Invalid input" } })}\n`),
  );
  await expect(pending).rejects.toThrow("Invalid input");
  rpc.close();
});
