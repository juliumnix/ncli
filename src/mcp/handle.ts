import { existsSync } from "node:fs";
import { busRpc } from "../bus/client";
import { callBusTool } from "./bus-tools";
import { BUS_TOOL_NAMES, NCLI_TOOLS } from "./tools";

export const MCP_PROTOCOL_VERSIONS = ["2025-07-28", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_PROTOCOL_DEFAULT = "2025-03-26";

export interface McpRpcReq {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpSession {
  session: string;
  ticket?: string;
  sock: string;
  callControl: (name: string, args: Record<string, unknown>, from: string) => Promise<string>;
}

export async function handleMcpRpc(req: McpRpcReq, ctx: McpSession): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const method = req.method ?? "";
  switch (method) {
    case "initialize": {
      const asked = String(req.params?.protocolVersion ?? "");
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_DEFAULT;
      return {
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "ncli", version: "0.3.0" },
        },
      };
    }
    case "notifications/initialized":
      return { result: null };
    case "tools/list":
      return { result: { tools: NCLI_TOOLS } };
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      const text = await callMcpTool(name, args, ctx);
      return { result: { content: [{ type: "text", text }] } };
    }
    case "ping":
      return { result: {} };
    default:
      return { error: { code: -32601, message: `unknown method ${method}` } };
  }
}

export async function callMcpTool(name: string, args: Record<string, unknown>, ctx: McpSession): Promise<string> {
  if (!existsSync(ctx.sock)) return "ncli offline — MCP exists only while the NCLI server is running";
  if ((BUS_TOOL_NAMES as readonly string[]).includes(name)) {
    return callBusTool(name, args, { sock: ctx.sock, session: ctx.session, ticket: ctx.ticket });
  }
  if (ctx.callControl) return ctx.callControl(name, args, ctx.session);
  const r = await busRpc(ctx.sock, {
    from: ctx.session,
    kind: "event",
    op: "mcp",
    body: JSON.stringify({ name, args }),
  });
  return r.body;
}
