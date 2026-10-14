import { appendFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  MCP_BLOCKED,
  mcpFromCursorServers,
  recallImportState,
  replyFromRecall,
  wantsMemoryState,
} from "./fake-ncli-mcp";

const logPath = process.env.FAKE_CURSOR_LOG;
if (logPath) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), t: Date.now() })}\n`,
  );
}

const model = process.env.FAKE_CURSOR_MODEL || "composer-2.5";
const delayInit = Number(process.env.FAKE_CURSOR_INIT_MS ?? "0") || 0;
const delayToken = Number(process.env.FAKE_CURSOR_TOKEN_MS ?? "0") || 0;
const reply = process.env.FAKE_CURSOR_REPLY ?? "oi";

function send(obj: unknown): void {
  writeSync(1, `${JSON.stringify(obj)}\n`);
}

let mcp: { url: string; token: string } | null = null;
let sessionId = "";
let nextOut = 800;
const permForPrompt = new Map<number, number>();

function promptText(params: unknown): string {
  const p = params as { prompt?: Array<{ text?: string }> };
  return (p.prompt ?? []).map((c) => c.text ?? "").join("\n");
}

async function finishPrompt(id: number, text: string): Promise<void> {
  if (delayToken) await Bun.sleep(delayToken);
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: { sessionUpdate: "model", model },
    },
  });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

function askPermission(promptId: number): void {
  const id = nextOut++;
  permForPrompt.set(id, promptId);
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolCallId: "recall-1", title: "mcp__ncli__recall" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
}

async function finishMemory(promptId: number, result: unknown): Promise<void> {
  const optionId = (result as { outcome?: { optionId?: string } })?.outcome?.optionId ?? "";
  if (optionId !== "allow-always" || !mcp) {
    await finishPrompt(promptId, MCP_BLOCKED);
    return;
  }
  await finishPrompt(promptId, replyFromRecall(await recallImportState(mcp)));
}

async function handle(msg: {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}): Promise<void> {
  if (msg.id !== undefined && msg.result !== undefined && !msg.method) {
    const promptId = permForPrompt.get(msg.id);
    if (promptId !== undefined) {
      permForPrompt.delete(msg.id);
      await finishMemory(promptId, msg.result);
    }
    return;
  }
  const id = msg.id;
  const method = msg.method ?? "";
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({ in: method || "result", id, hasResult: msg.result !== undefined, t: Date.now() })}\n`);
  }
  if (id === undefined) return;
  switch (method) {
    case "initialize":
      if (delayInit) await Bun.sleep(delayInit);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-cursor", version: "0" },
          agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } },
        },
      });
      return;
    case "session/new": {
      sessionId = process.env.FAKE_CURSOR_SESSION || randomUUID();
      const params = msg.params as { cwd?: string; additionalDirectories?: string[]; mcpServers?: unknown };
      mcp = mcpFromCursorServers(params.mcpServers);
      if (logPath) {
        appendFileSync(
          logPath,
          `${JSON.stringify({
            method: "session/new",
            sessionId,
            cwd: params.cwd,
            additionalDirectories: params.additionalDirectories ?? [],
            t: Date.now(),
          })}\n`,
        );
      }
      send({ jsonrpc: "2.0", id, result: { sessionId } });
      return;
    }
    case "session/prompt": {
      const text = promptText(msg.params);
      if (logPath) appendFileSync(logPath, `${JSON.stringify({ prompt: text.slice(-120), memory: wantsMemoryState(text) })}\n`);
      if (!wantsMemoryState(text)) {
        await finishPrompt(id, reply);
        return;
      }
      askPermission(id);
      return;
    }
    default:
      send({ jsonrpc: "2.0", id, result: {} });
  }
}

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      continue;
    }
    await handle(msg);
  }
}
