import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_3D_CSP, LIVE_DOC_CSP } from "./compartment";

export type LiveOrigin = {
  origin: string;
  put: (html: string) => string;
  stop: () => void;
};

const SHELL = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${LIVE_DOC_CSP}"><meta name="color-scheme" content="dark"><style>html,body{margin:0;width:100%;height:100%;background:#0f0f11;color:#eeeef0;color-scheme:dark}</style></head><body><script>
function ncliFail(err){
  var msg=String(err&&err.message||err||"shell vazio");
  document.documentElement.style.colorScheme="dark";
  document.body.style.background="#0f0f11";
  document.body.innerHTML='<div style="padding:12px;color:#f2777a;font:12px/1.4 ui-sans-serif,system-ui">não deu para renderizar<div style="color:#a8a8b3;margin-top:6px;white-space:pre-wrap">'+msg.replace(/[<>&]/g,function(c){return c==="<"?"&lt;":c===">"?"&gt;":"&amp;"})+"</div></div>";
  try{parent.postMessage({type:"ncli-live",op:"error",message:msg,name:String(window.name||"")},"*")}catch(e2){}
}
function ncliWrite(html){if(!html){ncliFail("hash vazio");return}document.open();document.write(html);document.close()}
try{
  var raw=decodeURIComponent(String(location.hash||"").replace(/^#/,""));
  if(!raw.trim()) ncliFail("hash vazio");
  else ncliWrite(raw);
}catch(e){ncliFail(e)}
addEventListener("message",function(e){
  if(!e.data||e.data.type!=="ncli-live-doc"||typeof e.data.html!=="string")return;
  try{ncliWrite(e.data.html)}catch(err){ncliFail(err)}
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
