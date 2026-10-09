import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Hub } from "./hub";
import type { NcliConfig } from "./config";
import type { HarnessKind } from "./config";
import type { HubEvent } from "./types";
import { handleMcpHttp } from "./mcp/http";

export function serve(hub: Hub, cfg: NcliConfig, publicDir: string): ReturnType<typeof Bun.serve> {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();

  hub.subscribe((ev) => {
    const chunk = enc.encode(`data: ${JSON.stringify(ev)}\n\n`);
    for (const c of clients) {
      try {
        c.enqueue(chunk);
      } catch {
        clients.delete(c);
      }
    }
  });

  return Bun.serve({
    port: cfg.port,
    hostname: cfg.host,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/mcp") return handleMcpHttp(req, hub.mcp, (who) => hub.mcpSession(who));
      if (url.pathname === "/api/events") {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            clients.add(c);
            c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "hello", userName: hub.cfg.userName })}\n\n`));
            const snap: HubEvent = { type: "views", views: hub.views.list() };
            c.enqueue(enc.encode(`data: ${JSON.stringify(snap)}\n\n`));
            c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "main", main: hub.mainAgent() })}\n\n`));
            c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "compact", compact: hub.compact })}\n\n`));
            c.enqueue(enc.encode(`data: ${JSON.stringify(hub.snapshot().context)}\n\n`));
            if (hub.live) c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "turn", session: "main", turn: hub.live.turn })}\n\n`));
          },
          cancel() {
            clients.delete(controller);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }
      if (url.pathname === "/api/state") {
        return Response.json(hub.snapshot());
      }
      if (url.pathname === "/api/message" && req.method === "POST") {
        const body = (await req.json()) as { text?: string };
        void hub.send(body.text ?? "");
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/stop" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { session?: string };
        return Response.json({ ok: hub.stopTurn(body.session ?? "main") });
      }
      if (url.pathname === "/api/harness" && req.method === "POST") {
        const body = (await req.json()) as { harness?: string };
        const kind = body.harness as HarnessKind;
        if (kind !== "claude" && kind !== "codex" && kind !== "cursor" && kind !== "mock") {
          return Response.json({ ok: false, error: `harness desconhecido: ${body.harness}` }, { status: 400 });
        }
        hub.switchMain(kind);
        return Response.json({ ok: true, main: hub.mainAgent() });
      }
      if (url.pathname === "/api/forks" && req.method === "POST") {
        const body = (await req.json()) as { view?: string; params?: Record<string, string> };
        const rt = await hub.forks.open(body.view ?? "", body.params ?? {});
        return Response.json({ ok: true, fork: rt.fork });
      }
      const forkMsg = url.pathname.match(/^\/api\/forks\/([^/]+)\/message$/);
      if (forkMsg && req.method === "POST") {
        const body = (await req.json()) as { text?: string };
        void hub.forks.message(decodeURIComponent(forkMsg[1]), body.text ?? "");
        return Response.json({ ok: true });
      }
      const forkAck = url.pathname.match(/^\/api\/forks\/([^/]+)\/ack$/);
      if (forkAck && req.method === "POST") {
        const body = (await req.json()) as { summary?: string };
        await hub.ackFork(decodeURIComponent(forkAck[1]), body.summary);
        return Response.json({ ok: true });
      }
      const forkAct = url.pathname.match(/^\/api\/forks\/([^/]+)\/act$/);
      if (forkAct && req.method === "POST") {
        const body = (await req.json()) as { type?: string; id?: string; value?: string };
        const fork = await hub.actFork(decodeURIComponent(forkAct[1]), {
          type: body.type ?? "say",
          id: body.id,
          value: body.value,
        });
        const plugin = hub.views.get(fork.view);
        return Response.json({ ok: true, fork, html: plugin?.render?.(fork) });
      }
      const forkGet = url.pathname.match(/^\/api\/forks\/([^/]+)$/);
      if (forkGet && req.method === "GET") {
        const rt = hub.forks.get(decodeURIComponent(forkGet[1]));
        if (!rt) return new Response("not found", { status: 404 });
        const plugin = hub.views.get(rt.fork.view);
        return Response.json({
          fork: rt.fork,
          messages: rt.memory.log,
          debug: rt.memory.debug(),
          html: plugin?.render?.(rt.fork),
        });
      }
      if (url.pathname === "/api/memory" && req.method === "GET") {
        const session = url.searchParams.get("session") ?? "main";
        if (session === "main") return Response.json(hub.memory.debug());
        const rt = hub.forks.get(session);
        if (!rt) return new Response("not found", { status: 404 });
        return Response.json(rt.memory.debug());
      }
      if (url.pathname === "/api/memory/zoom") {
        const id = Number(url.searchParams.get("id"));
        const n = Number(url.searchParams.get("n"));
        const session = url.searchParams.get("session") ?? "main";
        const mem = session === "main" ? hub.memory : hub.forks.get(session)?.memory;
        if (!mem) return new Response("not found", { status: 404 });
        return Response.json(mem.zoom(id, n));
      }
      if (url.pathname === "/api/views") {
        return Response.json(hub.views.list());
      }
      return staticFile(publicDir, url.pathname);
    },
  });
}

function staticFile(root: string, pathname: string): Response {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const wanted = rel === "/favicon.ico" ? ["/favicon.svg", "/favicon.ico"] : [rel];
  for (const p of wanted) {
    const abs = join(root, p);
    if (!existsSync(abs)) continue;
    return new Response(Bun.file(abs));
  }
  return new Response("not found", { status: 404 });
}
