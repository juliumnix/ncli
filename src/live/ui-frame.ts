export const NCLI_UI_TOKENS = {
  bg: "#0e0e0f",
  card: "#161618",
  line: "#262628",
  fg: "#ececec",
  muted: "#8a8a8a",
  accent: "#c2603d",
} as const;

export const UI_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'";

export type UiHostMsg =
  | { type: "ncli-ui"; op: "height"; h: number }
  | { type: "ncli-ui"; op: "send"; text: string };

export function parseUiHostMsg(data: unknown): UiHostMsg | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (o.type !== "ncli-ui") return null;
  if (o.op === "height" && typeof o.h === "number" && Number.isFinite(o.h) && o.h > 0 && o.h < 8000) {
    return { type: "ncli-ui", op: "height", h: Math.round(o.h) };
  }
  if (o.op === "send" && typeof o.text === "string") {
    const text = o.text.trim();
    if (!text || text.length > 4000) return null;
    return { type: "ncli-ui", op: "send", text };
  }
  return null;
}

export function extractUiBody(source: string): string {
  const raw = String(source ?? "").trim();
  const m = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return (m ? m[1] : raw).trim();
}

export function uiKey(source: string): string {
  let h = 2166136261;
  const s = String(source ?? "");
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function liveDocCss(): string {
  const t = NCLI_UI_TOKENS;
  return `:root{--bg:${t.bg};--card:${t.card};--line:${t.line};--fg:${t.fg};--muted:${t.muted};--accent:${t.accent}}
html,body{margin:0;padding:8px;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,sans-serif}
a{color:var(--accent)}`;
}

export function wrapUiSource(source: string): string {
  const body = extractUiBody(source);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${UI_CSP}"><style>${uiThemeCss()}</style><script>${uiLibScript()}</script></head><body>${body}<script>${uiHeightScript()}</script></body></html>`;
}

export function uiThemeCss(): string {
  const t = NCLI_UI_TOKENS;
  return `:root{--bg:${t.bg};--card:${t.card};--line:${t.line};--fg:${t.fg};--muted:${t.muted};--accent:${t.accent}}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;overflow:hidden}
body{padding:16px 16px 18px}
*{box-sizing:border-box}
h1,h2,h3{font-size:15px;font-weight:600;margin:0 0 10px}
.muted,.hint{color:var(--muted)}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
.tabs button{appearance:none;border:0;background:transparent;color:var(--muted);padding:6px 10px;border-radius:999px;font:12px/1.2 inherit;cursor:pointer}
.tabs button.on{color:var(--fg);background:#2a2422;box-shadow:inset 0 -2px 0 var(--accent)}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:0 0 14px}
.metric{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.metric b{display:block;font-size:18px}
.metric span{color:var(--muted);font-size:11px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);font-size:12px}
th{color:var(--muted);font-weight:600}
.badge{display:inline-block;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.02em}
.badge.ok{background:#243028;color:#b7d4bf}
.badge.warn{background:#2a2618;color:#e6d39a}
.badge.bad{background:#2a1c1c;color:#e8b4b4}
.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:8px}
.gallery .ph{height:140px;border-radius:12px;background:var(--card);border:1px solid var(--line)}
input[type=range]{width:100%;accent-color:var(--accent)}
.ncli-tip{position:fixed;z-index:9;pointer-events:none;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:11px;box-shadow:0 8px 24px #0006}
.ncli-chart{width:100%;height:180px;display:block}
html.ui-fill,html.ui-fill body{height:100%;box-sizing:border-box}
html.ui-fill body{display:flex;flex-direction:column;overflow:auto}
html.ui-fill #c1,html.ui-fill .ncli-chart-host{flex:1 1 auto;min-height:280px;width:100%}
html.ui-fill .ncli-chart{height:100%}`;
}

export function uiHostScript(): string {
  return `${uiLibScript()}\n${uiHeightScript()}`;
}

export function uiLibScript(): string {
  return `window.ncliUi={send:function(t){parent.postMessage({type:"ncli-ui",op:"send",text:String(t||"")},"*")}};
window._ncliCharts=window._ncliCharts||[];
window.ncliChart=function(el,spec){
  if(!el||!spec)return;
  var labels=spec.labels||[], vals=(spec.values||[]).map(Number), pad=28;
  var max=Math.max.apply(null,vals.concat([1])), min=Math.min.apply(null,vals.concat([0]));
  var span=max-min||1, n=vals.length;
  var tip=el._ncliTip;
  if(!tip){tip=document.createElement("div"); tip.className="ncli-tip"; tip.hidden=true; document.body.appendChild(tip); el._ncliTip=tip}
  var focus=-1, w=320, h=180, inner=264, step=inner;
  function measure(){
    w=Math.max(160, el.clientWidth||320);
    h=Math.max(180, el.clientHeight||180);
    inner=w-pad*2;
    step=n>1?inner/(n-1):inner;
  }
  function xy(i){var x=pad+i*step; var y=pad+(h-pad*2)*(1-(vals[i]-min)/span); return [x,y]}
  function draw(){
    measure();
    var d="", bars="", dots="";
    for(var i=0;i<n;i++){var p=xy(i); d+=(i?"L":"M")+p[0].toFixed(1)+","+p[1].toFixed(1)}
    if(spec.type==="bar"){
      var bw=Math.max(6, inner/Math.max(n,1)*0.6);
      for(var j=0;j<n;j++){var q=xy(j); bars+='<rect data-i="'+j+'" x="'+(q[0]-bw/2).toFixed(1)+'" y="'+q[1].toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+(h-pad-q[1]).toFixed(1)+'" rx="3" fill="var(--accent)" opacity="'+(focus<0||focus===j?"1":".35")+'"/>'}
    }
    for(var k=0;k<n;k++){var r=xy(k); dots+='<circle data-i="'+k+'" cx="'+r[0].toFixed(1)+'" cy="'+r[1].toFixed(1)+'" r="'+(focus===k?6:4)+'" fill="var(--accent)"/>'}
    el.innerHTML='<svg class="ncli-chart" viewBox="0 0 '+w+' '+h+'" width="100%" height="100%">'+(spec.type==="bar"?bars:'<path d="'+d+'" fill="none" stroke="var(--accent)" stroke-width="2"/>')+dots+'</svg>';
  }
  if(!el._ncliBound){
    el._ncliBound=true;
    window._ncliCharts.push(draw);
    if(window.ResizeObserver) new ResizeObserver(draw).observe(el);
  }
  draw();
  el.onmousemove=function(ev){
    var t=ev.target, i=t && t.getAttribute && t.getAttribute("data-i");
    if(i==null){tip.hidden=true;return}
    var idx=+i;
    tip.hidden=false; tip.textContent=(labels[idx]||idx)+": "+vals[idx];
    tip.style.left=Math.min(inner, ev.clientX+12)+"px"; tip.style.top=Math.max(8, ev.clientY-28)+"px";
  };
  el.onmouseleave=function(){tip.hidden=true};
  el.onclick=function(ev){
    var t=ev.target, i=t && t.getAttribute && t.getAttribute("data-i");
    focus=i==null?-1:(+i===focus?-1:+i);
    draw();
  };
};`;
}

export function uiHeightScript(): string {
  return `function ncliReport(){if(document.documentElement.classList.contains("ui-fill"))return;var h=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight);parent.postMessage({type:"ncli-ui",op:"height",h:h},"*")}
function ncliLayout(mode){document.documentElement.classList.toggle("ui-fill",mode==="fill");(window._ncliCharts||[]).forEach(function(fn){fn()});ncliReport()}
addEventListener("message",function(ev){var d=ev.data;if(d&&d.type==="ncli-ui"&&d.op==="layout")ncliLayout(d.mode)});
new ResizeObserver(ncliReport).observe(document.body);
addEventListener("load",ncliReport);
ncliReport();`;
}
