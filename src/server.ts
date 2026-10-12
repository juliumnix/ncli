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
            c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "queue", items: hub.queue.list() })}\n\n`));
            c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "usage", usage: hub.usage.snapshot() })}\n\n`));
            if (hub.lastImport) c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "import", preview: hub.lastImport })}\n\n`));
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
        const body = (await req.json()) as { text?: string; mode?: "steer" | "queue"; session?: string };
        void hub.send(body.text ?? "", { mode: body.mode, session: body.session });
        return Response.json({ ok: true, queue: hub.queue.list() });
      }
      if (url.pathname.startsWith("/api/queue/") && req.method === "DELETE") {
        const id = decodeURIComponent(url.pathname.slice("/api/queue/".length));
        return Response.json({ ok: hub.dropQueued(id), queue: hub.queue.list() });
      }
      if (url.pathname === "/api/stop" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { session?: string };
        return Response.json({ ok: hub.stopTurn(body.session ?? "main") });
      }
      if (url.pathname === "/api/import" && req.method === "GET") {
        const source = url.searchParams.get("source") ?? "";
        if (source !== "claude" && source !== "codex" && source !== "cursor") {
          return Response.json({ ok: false, error: "source claude|codex|cursor" }, { status: 400 });
        }
        const since = url.searchParams.get("since") ?? undefined;
        return Response.json({ ok: true, preview: hub.previewImport(source, since) });
      }
      if (url.pathname === "/api/import" && req.method === "POST") {
        const body = (await req.json()) as { source?: string; since?: string; apply?: boolean };
        const source = body.source ?? "";
        if (source !== "claude" && source !== "codex" && source !== "cursor") {
          return Response.json({ ok: false, error: "source claude|codex|cursor" }, { status: 400 });
        }
        if (body.apply) {
          return Response.json({ ok: true, apply: hub.applyImport(source, body.since) });
        }
        return Response.json({ ok: true, preview: hub.previewImport(source, body.since) });
      }
      if (url.pathname === "/api/usage" && req.method === "POST") {
        const body = (await req.json()) as { seat?: string; policy?: "resume" | "snooze" };
        const seat = body.seat;
        if (seat !== "claude" && seat !== "codex" && seat !== "cursor" && seat !== "mock") {
          return Response.json({ ok: false, error: `seat desconhecida: ${body.seat}` }, { status: 400 });
        }
        if (body.policy !== "resume" && body.policy !== "snooze") {
          return Response.json({ ok: false, error: "policy resume|snooze" }, { status: 400 });
        }
        return Response.json({ ok: true, usage: hub.setUsagePolicy(seat, body.policy) });
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
      if ((url.pathname === "/api/sparks" || url.pathname === "/api/forks") && req.method === "POST") {
        const body = (await req.json()) as { view?: string; params?: Record<string, string> };
        const rt = await hub.sparks.open(body.view ?? "", body.params ?? {});
        return Response.json({ ok: true, spark: rt.spark, fork: rt.spark });
      }
      const sparkMsg = url.pathname.match(/^\/api\/(?:sparks|forks)\/([^/]+)\/message$/);
      if (sparkMsg && req.method === "POST") {
        const body = (await req.json()) as { text?: string };
        void hub.sparks.message(decodeURIComponent(sparkMsg[1]), body.text ?? "");
        return Response.json({ ok: true });
      }
      const sparkArchive = url.pathname.match(/^\/api\/(?:sparks|forks)\/([^/]+)\/archive$/);
      if (sparkArchive && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { force?: boolean };
        const result = await hub.sparks.archive(decodeURIComponent(sparkArchive[1]), body.force === true);
        return Response.json({ ok: result?.ok ?? false, archive: result });
      }
      const sparkAck = url.pathname.match(/^\/api\/(?:sparks|forks)\/([^/]+)\/ack$/);
      if (sparkAck && req.method === "POST") {
        const body = (await req.json()) as { summary?: string };
        await hub.ackSpark(decodeURIComponent(sparkAck[1]), body.summary);
        return Response.json({ ok: true });
      }
      const sparkAct = url.pathname.match(/^\/api\/(?:sparks|forks)\/([^/]+)\/act$/);
      if (sparkAct && req.method === "POST") {
        const body = (await req.json()) as { type?: string; id?: string; value?: string };
        const spark = await hub.actSpark(decodeURIComponent(sparkAct[1]), {
          type: body.type ?? "say",
          id: body.id,
          value: body.value,
        });
        const plugin = hub.views.get(spark.view);
        return Response.json({ ok: true, spark, fork: spark, html: plugin?.render?.(spark) });
      }
      const sparkGet = url.pathname.match(/^\/api\/(?:sparks|forks)\/([^/]+)$/);
      if (sparkGet && req.method === "GET") {
        const rt = hub.sparks.get(decodeURIComponent(sparkGet[1]));
        if (!rt) return new Response("not found", { status: 404 });
        const plugin = hub.views.get(rt.spark.view);
        return Response.json({
          spark: rt.spark,
          fork: rt.spark,
          messages: rt.memory.log,
          debug: rt.memory.debug(),
          html: plugin?.render?.(rt.spark),
        });
      }
      if (url.pathname === "/api/memory" && req.method === "GET") {
        const session = url.searchParams.get("session") ?? "main";
        if (session === "main") return Response.json(hub.memory.debug());
        const rt = hub.sparks.get(session);
        if (!rt) return new Response("not found", { status: 404 });
        return Response.json(rt.memory.debug());
      }
      if (url.pathname === "/api/memory/zoom") {
        const id = Number(url.searchParams.get("id"));
        const n = Number(url.searchParams.get("n"));
        const session = url.searchParams.get("session") ?? "main";
        const mem = session === "main" ? hub.memory : hub.sparks.get(session)?.memory;
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
    const headers: Record<string, string> = {};
    if (p === "/ncli3d.js" || p === "/vendor/three.global.js") {
      headers["Cross-Origin-Resource-Policy"] = "cross-origin";
    }
    return new Response(Bun.file(abs), { headers });
  }
  return new Response("not found", { status: 404 });
}
