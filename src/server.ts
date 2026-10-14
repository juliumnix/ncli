import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hub } from "./hub";
import type { NcliConfig } from "./config";
import type { HarnessKind } from "./config";
import type { HubEvent } from "./types";
import { handleMcpHttp } from "./mcp/http";
import { sanitizeViewHtml } from "./util";
import { liveOrigin } from "./live/origin";
import { publicJson, redactValue } from "./redact";

export function serve(hub: Hub, cfg: NcliConfig, publicDir: string): ReturnType<typeof Bun.serve> {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();

  const wire = (ev: unknown) => enc.encode(`data: ${JSON.stringify(redactValue(ev))}\n\n`);
  hub.subscribe((ev) => {
    const chunk = wire(ev);
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
            c.enqueue(wire({ type: "hello", userName: hub.cfg.userName }));
            const snap: HubEvent = { type: "views", views: hub.views.list() };
            c.enqueue(wire(snap));
            c.enqueue(wire({ type: "main", main: hub.mainAgent() }));
            c.enqueue(wire({ type: "compact", compact: hub.compact }));
            c.enqueue(wire(hub.snapshot().context));
            if (hub.live) c.enqueue(wire({ type: "turn", session: "main", turn: hub.live.turn }));
            c.enqueue(wire({ type: "queue", items: hub.queue.list() }));
            c.enqueue(wire({ type: "usage", usage: hub.usage.snapshot() }));
            if (hub.lastImport) {
              c.enqueue(wire({ type: "import", preview: hub.lastImport, offers: hub.importOffers }));
            }
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
        return publicJson(hub.snapshot());
      }
      if (url.pathname === "/api/message" && req.method === "POST") {
        const body = (await req.json()) as { text?: string; mode?: "steer" | "queue"; session?: string };
        void hub.send(body.text ?? "", { mode: body.mode, session: body.session });
        return publicJson({ ok: true, queue: hub.queue.list() });
      }
      const queueNow = url.pathname.match(/^\/api\/queue\/([^/]+)\/now$/);
      if (queueNow && req.method === "POST") {
        const id = decodeURIComponent(queueNow[1]!);
        return publicJson({ ok: hub.sendNow(id), queue: hub.queue.list() });
      }
      if (url.pathname.startsWith("/api/queue/") && req.method === "PATCH") {
        const id = decodeURIComponent(url.pathname.slice("/api/queue/".length));
        const body = (await req.json()) as { text?: string };
        return publicJson({ ok: hub.editQueued(id, body.text ?? ""), queue: hub.queue.list() });
      }
      if (url.pathname.startsWith("/api/queue/") && req.method === "DELETE") {
        const id = decodeURIComponent(url.pathname.slice("/api/queue/".length));
        return publicJson({ ok: hub.dropQueued(id), queue: hub.queue.list() });
      }
      if (url.pathname === "/api/stop" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { session?: string };
        return publicJson({ ok: hub.stopTurn(body.session ?? "main") });
      }
      if (url.pathname === "/api/import" && req.method === "GET") {
        const source = url.searchParams.get("source") ?? "";
        if (source !== "claude" && source !== "codex" && source !== "cursor") {
          return publicJson({ ok: false, error: "source claude|codex|cursor" }, { status: 400 });
        }
        const since = url.searchParams.get("since") ?? undefined;
        return publicJson({ ok: true, preview: hub.previewImport(source, since) });
      }
      if (url.pathname === "/api/import" && req.method === "POST") {
        const body = (await req.json()) as { source?: string; since?: string; apply?: boolean };
        const source = body.source ?? "";
        if (source !== "claude" && source !== "codex" && source !== "cursor") {
          return publicJson({ ok: false, error: "source claude|codex|cursor" }, { status: 400 });
        }
        if (body.apply) {
          void hub.applyImport(source, body.since, { surface: hub.memory.T === 0 }).catch(() => undefined);
          return publicJson({ ok: true, started: true, via: "job" });
        }
        return publicJson({ ok: true, preview: hub.previewImport(source, body.since) });
      }
      if (url.pathname === "/api/compact" && req.method === "POST") {
        hub.retryCompact();
        return publicJson({ ok: true, compact: hub.compact });
      }
      if (url.pathname === "/api/usage" && req.method === "POST") {
        const body = (await req.json()) as { seat?: string; policy?: "resume" | "snooze" };
        const seat = body.seat;
        if (seat !== "claude" && seat !== "codex" && seat !== "cursor" && seat !== "mock") {
          return publicJson({ ok: false, error: `seat desconhecida: ${body.seat}` }, { status: 400 });
        }
        if (body.policy !== "resume" && body.policy !== "snooze") {
          return publicJson({ ok: false, error: "policy resume|snooze" }, { status: 400 });
        }
        return publicJson({ ok: true, usage: hub.setUsagePolicy(seat, body.policy) });
      }
      if (url.pathname === "/api/harness" && req.method === "POST") {
        const body = (await req.json()) as { harness?: string };
        const kind = body.harness as HarnessKind;
        if (kind !== "claude" && kind !== "codex" && kind !== "cursor" && kind !== "mock") {
          return publicJson({ ok: false, error: `harness desconhecido: ${body.harness}` }, { status: 400 });
        }
        hub.switchMain(kind);
        return publicJson({ ok: true, main: hub.mainAgent() });
      }
      if ((url.pathname === "/api/sparks" || url.pathname === "/api/forks") && req.method === "POST") {
        const body = (await req.json()) as { view?: string; params?: Record<string, string> };
        const rt = await hub.sparks.open(body.view ?? "", body.params ?? {});
        return publicJson({ ok: true, spark: rt.spark, fork: rt.spark });
      }
      const sparkMsg = url.pathname.match(/^\/api\/(?:sparks|forks)\/([^/]+)\/message$/);
      if (sparkMsg && req.method === "POST") {
        const body = (await req.json()) as { text?: string };
        void hub.sparks.message(decodeURIComponent(sparkMsg[1]), body.text ?? "");
        return publicJson({ ok: true });
      }
      const sparkShip = url.pathname.match(/^\/api\/(?:sparks|forks)\/([^/]+)\/ship$/);
      if (sparkShip && req.method === "POST") {
        const result = await hub.sparks.ship(decodeURIComponent(sparkShip[1]));
        return publicJson(result);
      }
      const sparkArchive = url.pathname.match(/^\/api\/(?:sparks|forks)\/([^/]+)\/archive$/);
      if (sparkArchive && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { force?: boolean };
        const result = await hub.sparks.archive(decodeURIComponent(sparkArchive[1]), body.force === true);
        return publicJson({ ok: result?.ok ?? false, archive: result });
      }
      const sparkAck = url.pathname.match(/^\/api\/(?:sparks|forks)\/([^/]+)\/ack$/);
      if (sparkAck && req.method === "POST") {
        const body = (await req.json()) as { summary?: string };
        await hub.ackSpark(decodeURIComponent(sparkAck[1]), body.summary);
        return publicJson({ ok: true });
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
        const raw = plugin?.render?.(spark);
        return publicJson({ ok: true, spark, fork: spark, html: raw === undefined ? undefined : sanitizeViewHtml(raw) });
      }
      const sparkGet = url.pathname.match(/^\/api\/(?:sparks|forks)\/([^/]+)$/);
      if (sparkGet && req.method === "GET") {
        const rt = hub.sparks.get(decodeURIComponent(sparkGet[1]));
        if (!rt) return new Response("not found", { status: 404 });
        const plugin = hub.views.get(rt.spark.view);
        const raw = plugin?.render?.(rt.spark);
        return publicJson({
          spark: rt.spark,
          fork: rt.spark,
          messages: rt.memory.log,
          debug: rt.memory.debug(),
          html: raw === undefined ? undefined : sanitizeViewHtml(raw),
          ship: await hub.sparks.shipPlanOf(rt.spark.id),
        });
      }
      if (url.pathname === "/api/memory" && req.method === "GET") {
        const session = url.searchParams.get("session") ?? "main";
        if (session === "main") return publicJson(hub.memory.debug());
        const rt = hub.sparks.get(session);
        if (!rt) return new Response("not found", { status: 404 });
        return publicJson(rt.memory.debug());
      }
      if (url.pathname === "/api/memory/zoom") {
        const id = Number(url.searchParams.get("id"));
        const n = Number(url.searchParams.get("n"));
        const session = url.searchParams.get("session") ?? "main";
        const mem = session === "main" ? hub.memory : hub.sparks.get(session)?.memory;
        if (!mem) return new Response("not found", { status: 404 });
        return publicJson(mem.zoom(id, n));
      }
      if (url.pathname === "/api/views") {
        return publicJson(hub.views.list());
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
    if (p === "/index.html") {
      const origin = liveOrigin()?.origin ?? "";
      const html = readFileSync(abs, "utf8").replace(
        "</head>",
        `<script>window.NCLI_LIVE_ORIGIN=${JSON.stringify(origin)}</script></head>`,
      );
      headers["content-type"] = "text/html; charset=utf-8";
      return new Response(html, { headers });
    }
    return new Response(Bun.file(abs), { headers });
  }
  return new Response("not found", { status: 404 });
}
