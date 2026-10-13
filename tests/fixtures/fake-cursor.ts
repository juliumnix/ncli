import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

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
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handle(msg: {
  id?: number;
  method?: string;
  params?: unknown;
}): Promise<void> {
  const id = msg.id;
  const method = msg.method ?? "";
  if (id === undefined) return;
  switch (method) {
    case "initialize":
      if (delayInit) await Bun.sleep(delayInit);
      send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { name: "fake-cursor", version: "0" } } });
      return;
    case "session/new": {
      const sessionId = process.env.FAKE_CURSOR_SESSION || randomUUID();
      if (logPath) {
        appendFileSync(logPath, `${JSON.stringify({ method: "session/new", sessionId, t: Date.now() })}\n`);
      }
      send({ jsonrpc: "2.0", id, result: { sessionId } });
      return;
    }
    case "session/prompt":
      if (delayToken) await Bun.sleep(delayToken);
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: reply },
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
      return;
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
    let msg: { id?: number; method?: string; params?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      continue;
    }
    await handle(msg);
  }
}
