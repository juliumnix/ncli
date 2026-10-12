import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_3D_CSP, LIVE_DOC_CSP } from "./compartment";

export type LiveOrigin = {
  origin: string;
  put: (html: string) => string;
  stop: () => void;
};

const SHELL = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${LIVE_DOC_CSP}"><style>html,body{margin:0;width:100%;height:100%;background:transparent}</style></head><body><script>
function ncliWrite(html){if(!html)return;document.open();document.write(html);document.close()}
try{ncliWrite(decodeURIComponent(String(location.hash||"").replace(/^#/,"")))}catch(e){}
addEventListener("message",function(e){
  if(!e.data||e.data.type!=="ncli-live-doc"||typeof e.data.html!=="string")return;
  ncliWrite(e.data.html);
});
</script></body></html>`;

let current: LiveOrigin | null = null;

export function liveOrigin(): LiveOrigin | null {
  return current;
}

const HASH_CAP = 60_000;

export function liveDocUrl(html: string): string {
  const live = current;
  if (!live) return "";
  const encoded = encodeURIComponent(html);
  if (encoded.length > HASH_CAP) return live.put(html);
  return `${live.origin}/shell#${encoded}`;
}

export function setLiveOrigin(next: LiveOrigin | null): void {
  current = next;
}

export function startLiveOrigin(opts: { port?: number; publicDir: string }): LiveOrigin {
  const frames = new Map<string, string>();
  const publicDir = opts.publicDir;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req) {
      const url = new URL(req.url);
      const cors = {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      };
      if (url.pathname === "/shell") {
        return new Response(SHELL, {
          headers: { ...cors, "content-type": "text/html; charset=utf-8", "content-security-policy": LIVE_DOC_CSP },
        });
      }
      if (url.pathname.startsWith("/f/")) {
        const html = frames.get(url.pathname.slice(3));
        if (!html) return new Response("gone", { status: 404, headers: cors });
        return new Response(html, {
          headers: { ...cors, "content-type": "text/html; charset=utf-8", "content-security-policy": LIVE_DOC_CSP },
        });
      }
      if (url.pathname === "/3d") {
        const file = join(publicDir, "ncli3d.html");
        const html = existsSync(file) ? readFileSync(file, "utf8") : "<p>3d</p>";
        return new Response(html, {
          headers: {
            ...cors,
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": LIVE_3D_CSP,
          },
        });
      }
      const staticPath =
        url.pathname === "/ncli3d.js" || url.pathname === "/vendor/three.global.js" || url.pathname === "/tokens.css"
          ? join(publicDir, url.pathname.replace(/^\//, ""))
          : "";
      if (staticPath && existsSync(staticPath)) {
        return new Response(Bun.file(staticPath), {
          headers: { ...cors, "cross-origin-resource-policy": "cross-origin" },
        });
      }
      return new Response("not found", { status: 404, headers: cors });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const handle: LiveOrigin = {
    origin,
    put(html: string) {
      const id = crypto.randomUUID();
      frames.set(id, html);
      return `${origin}/f/${id}`;
    },
    stop() {
      server.stop(true);
      if (current === handle) current = null;
    },
  };
  current = handle;
  return handle;
}
