#!/usr/bin/env bun
import { join } from "node:path";
import { busRpc } from "../bus/client";
import { loadConfig } from "../config";
import { handleMcpRpc, type McpRpcReq } from "./handle";

const cfg = loadConfig();
const session = process.env.NCLI_SESSION ?? "main";
const sock = process.env.NCLI_BUS_SOCK ?? join(cfg.dataDir, "ncli-bus.sock");

const stdin = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buf = "";

function send(id: number | string | undefined, payload: { result?: unknown; error?: unknown }): void {
  if (id === undefined) return;
  const body = JSON.stringify(payload.error
    ? { jsonrpc: "2.0", id, error: payload.error }
    : { jsonrpc: "2.0", id, result: payload.result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

for (;;) {
  const { value, done } = await stdin.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = buf.slice(0, headerEnd);
    const m = header.match(/Content-Length:\s*(\d+)/i);
    const len = m ? Number(m[1]) : 0;
    const start = headerEnd + 4;
    if (buf.length < start + len) break;
    const raw = buf.slice(start, start + len);
    buf = buf.slice(start + len);
    try {
      const req = JSON.parse(raw) as McpRpcReq;
      const out = await handleMcpRpc(req, {
        session,
        sock,
        ticket: process.env.NCLI_TICKET,
        callControl: async (name, args, from) => {
          const r = await busRpc(sock, {
            from,
            kind: "event",
            op: "mcp",
            body: JSON.stringify({ name, args }),
          });
          return r.body;
        },
      });
      send(req.id, out);
    } catch {
      continue;
    }
  }
}
