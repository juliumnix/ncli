#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config";
import { busRpc } from "../bus/client";
import { BUS_TOOL_NAMES, NCLI_TOOLS } from "./tools";
import { callBusTool } from "./bus-tools";

const cfg = loadConfig();
const session = process.env.NCLI_SESSION ?? "main";
const sock = process.env.NCLI_BUS_SOCK ?? join(cfg.dataDir, "ncli-bus.sock");

interface RpcReq {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

async function handle(req: RpcReq): Promise<unknown> {
  const method = req.method ?? "";
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ncli", version: "0.3.0" },
      };
    case "notifications/initialized":
      return null;
    case "tools/list":
      return { tools: NCLI_TOOLS };
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      return { content: [{ type: "text", text: await callTool(name, args) }] };
    }
    case "ping":
      return {};
    default:
      return { error: { code: -32601, message: `unknown method ${method}` } };
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (!existsSync(sock)) return "ncli offline — MCP exists only while the NCLI server is running";
  if ((BUS_TOOL_NAMES as readonly string[]).includes(name)) {
    return callBusTool(name, args, { sock, session, ticket: process.env.NCLI_TICKET });
  }
  const r = await busRpc(sock, {
    from: session,
    kind: "event",
    op: "mcp",
    body: JSON.stringify({ name, args }),
  });
  return r.body;
}

const stdin = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buf = "";

function send(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return;
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

for (;;) {
  const { value, done } = await stdin.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      const nl = buf.indexOf("\n{");
      if (nl >= 0) {
        const line = buf.slice(nl + 1);
        const end = line.indexOf("\n");
        const raw = end >= 0 ? line.slice(0, end) : line;
        buf = end >= 0 ? line.slice(end + 1) : "";
        try {
          const req = JSON.parse(raw) as RpcReq;
          const result = await handle(req);
          if (result && typeof result === "object" && "error" in (result as object) && req.id !== undefined) {
            const body = JSON.stringify({ jsonrpc: "2.0", id: req.id, error: (result as { error: unknown }).error });
            process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
          } else {
            send(req.id, result);
          }
        } catch {
          continue;
        }
        continue;
      }
      break;
    }
    const header = buf.slice(0, headerEnd);
    const m = header.match(/Content-Length:\s*(\d+)/i);
    const len = m ? Number(m[1]) : 0;
    const start = headerEnd + 4;
    if (buf.length < start + len) break;
    const raw = buf.slice(start, start + len);
    buf = buf.slice(start + len);
    try {
      const req = JSON.parse(raw) as RpcReq;
      const result = await handle(req);
      send(req.id, result);
    } catch {
      continue;
    }
  }
}
