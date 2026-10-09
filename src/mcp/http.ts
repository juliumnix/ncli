import { bearerToken, type McpGate } from "./auth";
import { handleMcpRpc, type McpRpcReq, type McpSession } from "./handle";

export async function handleMcpHttp(
  req: Request,
  gate: McpGate,
  sessionOf: (token: { session: string; ticket?: string }) => McpSession,
): Promise<Response> {
  if (req.method === "GET") {
    return new Response(":ok\n\n", {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
  if (req.method === "DELETE") return new Response(null, { status: 405 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const token = bearerToken(req);
  const who = gate.lookup(token);
  if (!who) return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null }, { status: 400 });
  }

  const ctx = sessionOf(who);
  const accept = req.headers.get("accept") ?? "";
  const preferSse = accept.includes("text/event-stream") && !accept.includes("application/json");

  if (Array.isArray(body)) {
    const replies = [];
    for (const item of body) replies.push(await replyOne(item as McpRpcReq, ctx));
    return pack(replies.filter(Boolean), preferSse);
  }
  const reply = await replyOne(body as McpRpcReq, ctx);
  if (!reply) return new Response(null, { status: 202 });
  return pack(reply, preferSse);
}

async function replyOne(req: McpRpcReq, ctx: McpSession): Promise<Record<string, unknown> | null> {
  const out = await handleMcpRpc(req, ctx);
  if (req.id === undefined) return null;
  if (out.error) return { jsonrpc: "2.0", id: req.id, error: out.error };
  return { jsonrpc: "2.0", id: req.id, result: out.result };
}

function pack(payload: unknown, sse: boolean): Response {
  if (!sse) {
    return Response.json(payload, { headers: { "Content-Type": "application/json" } });
  }
  const data = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return new Response(data, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
