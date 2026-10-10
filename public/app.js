const $ = (id) => document.getElementById(id);
const chat = $("chat");
const log = $("log") || chat;
const shortcuts = $("shortcuts");
const overlay = $("overlay");
const modal = $("modal");
const input = $("input");
const debugView = $("debugView");
const viewList = $("viewList");

const stick = { follow: true };
const STICK_SLOP = 64;

const state = {
  messages: [],
  forks: [],
  views: [],
  waiting: [],
  debug: null,
  context: null,
  ctxPrev: [],
  ctxOps: [],
  ctxRaw: false,
  ctxTree: false,
  switchOpen: false,
  workOpen: new Set(),
  zoomId: "",
  zoomLines: [],
  lastTurn: null,
  openFork: null,
  forkTab: "Guide",
  forkDetail: null,
  stream: "",
  streamSeat: "claude",
  streamModel: "",
  main: { harness: "claude", model: "" },
  turn: null,
  forkTurns: {},
  compact: null,
  userName: "Você",
};

const SEAT = {
  claude: { name: "Claude", src: "/icons/claude.svg" },
  codex: { name: "Codex", src: "/icons/openai.svg" },
  cursor: { name: "Cursor", src: "/icons/cursor.svg" },
};

function displayModel(raw) {
  if (!raw) return "";
  const named = raw.match(/(opus|sonnet|haiku)[^\d]*(\d+)(?:[.-](\d+))?/i);
  if (named) {
    const head = named[1][0].toUpperCase() + named[1].slice(1).toLowerCase();
    return named[3] ? `${head} ${named[2]}.${named[3]}` : `${head} ${named[2]}`;
  }
  if (raw === "mock") return "mock";
  const gpt = raw.match(/gpt-?(\d+)(?:[.-](\d+))?(-[a-z0-9]+)?/i);
  if (gpt) {
    const base = gpt[2] ? `GPT ${gpt[1]}.${gpt[2]}` : `GPT ${gpt[1]}`;
    return gpt[3] ? `${base}${gpt[3]}` : base;
  }
  return raw.replace(/^claude-?/i, "").replace(/-\d{8}$/, "") || raw;
}

function agentLabel(seat, model) {
  const meta = SEAT[seat] || SEAT.claude;
  const shown = displayModel(model);
  return shown ? `${meta.name} · ${shown}` : meta.name;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function bodyHtml(text, streaming) {
  const segs = [];
  const re = /```ncli[ \t]+(mermaid|html|react|url|ui)[ \t]*\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push(md(text.slice(last, m.index), false));
    segs.push(iframeFor(m[1], m[2].trim()));
    last = m.index + m[0].length;
  }
  const rest = text.slice(last);
  const open = rest.match(/```ncli[ \t]+(mermaid|html|react|url|ui)[ \t]*\n([\s\S]*)$/);
  if (open && !open[2].includes("```")) segs.push(shimmerFor(open[1], open[2]));
  else if (rest) segs.push(md(rest, streaming));
  return segs.join("") || md(text, streaming);
}

const mdMemo = new Map();

function md(text, streaming) {
  if (!streaming && mdMemo.has(text)) return mdMemo.get(text);
  const html = typeof renderMarkdown === "function" ? renderMarkdown(text, !!streaming) : rich(text);
  if (!streaming) {
    if (mdMemo.size > 400) mdMemo.clear();
    mdMemo.set(text, html);
  }
  return html;
}

function shimmerFor(kind, source) {
  const shape = kind === "mermaid" ? "diagram" : kind === "url" ? "page" : kind === "react" || kind === "ui" ? "card" : /chart|canvas|svg|bar|plot/i.test(source || "") ? "chart" : "card";
  const label = shape === "diagram" ? "desenhando diagrama…" : shape === "chart" ? "desenhando gráfico…" : kind === "ui" ? "montando o card…" : kind === "react" ? "montando componente…" : shape === "page" ? "carregando página…" : "montando prévia…";
  const body = shape === "diagram" ? "<i></i><i></i><i></i>" : shape === "chart" ? "<b></b><b></b><b></b><b></b>" : shape === "page" ? "<s></s><em></em><em></em><em></em>" : "<s></s><em></em><em></em>";
  return `<div class="live-ph" data-kind="${kind}" data-shape="${shape}" aria-busy="true"><div class="live-ph-label">${label}</div><div class="live-ph-body ${shape}">${body}</div></div>`;
}

function liveError(kind, source, error) {
  return `<div class="live-err" data-kind="${kind}"><div class="live-err-h">não deu para renderizar ${escapeHtml(kind)}</div><div class="live-err-m">${escapeHtml(error)}</div><pre class="live-err-src">${escapeHtml(source)}</pre></div>`;
}

function httpHref(raw) {
  const text = String(raw || "").trim();
  if (typeof URL.canParse === "function") {
    if (!URL.canParse(text)) return "";
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  }
  return /^https?:\/\/[^\s]+$/i.test(text) ? text : "";
}

function iframeFor(kind, source) {
  try {
    if (kind === "url") {
      const href = httpHref(source);
      if (!href) return liveError(kind, source, "url bloqueada");
      return `<div class="live-wrap in"><iframe class="live-frame" title="live url" sandbox="allow-scripts allow-popups" src="${escapeHtml(href)}"></iframe></div>`;
    }
    if (kind === "ui") {
      const key = uiKey(source);
      const srcdoc = wrapUiSource(source).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      return `<div class="ui-card live-wrap in" data-ui-key="${key}"><button type="button" class="ui-expand" aria-label="Expandir">⤢</button><iframe class="live-frame live-ui" title="live ui" data-ui-key="${key}" sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe></div>`;
    }
    const inner =
      kind === "mermaid"
        ? mermaidSvg(source)
        : kind === "react"
          ? jsxLite(source)
          : source;
    if (kind === "mermaid" && !/<rect |<svg /.test(inner)) {
      return liveError(kind, source, "diagrama sem nós");
    }
    const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><style>${liveDocCss()}</style></head><body>${inner}</body></html>`
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;");
    return `<div class="live-wrap in"><iframe class="live-frame" title="live ${kind}" sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe></div>`;
  } catch (err) {
    return liveError(kind, source, err instanceof Error ? err.message : String(err));
  }
}

function uiKey(source) {
  let h = 2166136261;
  const s = String(source || "");
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function extractUiBody(source) {
  const raw = String(source || "").trim();
  const m = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return (m ? m[1] : raw).trim();
}

function wrapUiSource(source) {
  const body = extractUiBody(source);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'"><style>${uiThemeCss()}</style><script>${uiLibScript()}</script></head><body>${body}<script>${uiHeightScript()}</script></body></html>`;
}

function liveDocCss() {
  return `:root{--bg:#0e0e0f;--card:#161618;--line:#262628;--fg:#ececec;--muted:#8a8a8a;--accent:#c2603d}
html,body{margin:0;padding:8px;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,sans-serif}
a{color:var(--accent)}`;
}

function uiThemeCss() {
  return `:root{--bg:#0e0e0f;--card:#161618;--line:#262628;--fg:#ececec;--muted:#8a8a8a;--accent:#c2603d}
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

function uiLibScript() {
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

function uiHeightScript() {
  return `function ncliReport(){if(document.documentElement.classList.contains("ui-fill"))return;var h=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight);parent.postMessage({type:"ncli-ui",op:"height",h:h},"*")}
function ncliLayout(mode){document.documentElement.classList.toggle("ui-fill",mode==="fill");(window._ncliCharts||[]).forEach(function(fn){fn()});ncliReport()}
addEventListener("message",function(ev){var d=ev.data;if(d&&d.type==="ncli-ui"&&d.op==="layout")ncliLayout(d.mode)});
new ResizeObserver(ncliReport).observe(document.body);
addEventListener("load",ncliReport);
ncliReport();`;
}

function parseUiHostMsg(data) {
  if (!data || typeof data !== "object") return null;
  if (data.type !== "ncli-ui") return null;
  if (data.op === "height" && typeof data.h === "number" && Number.isFinite(data.h) && data.h > 0 && data.h < 8000) {
    return { type: "ncli-ui", op: "height", h: Math.round(data.h) };
  }
  if (data.op === "send" && typeof data.text === "string") {
    const text = data.text.trim();
    if (!text || text.length > 4000) return null;
    return { type: "ncli-ui", op: "send", text };
  }
  return null;
}

let uiExpanded = null;

function expandUi(card) {
  const key = card.dataset.uiKey;
  const pane = $("uiPane");
  const body = $("uiPaneBody");
  if (!key || !pane || !body) return;
  if (uiExpanded && uiExpanded.key === key) {
    collapseUi();
    return;
  }
  if (uiExpanded) collapseUi();
  const frame = card.querySelector("iframe.live-ui");
  if (!frame) return;
  uiExpanded = { key };
  card.classList.add("expanded");
  body.appendChild(frame);
  pane.hidden = false;
  requestAnimationFrame(() => {
    document.body.classList.add("ui-open");
    signalLayout(frame, "fill");
    measureComposer();
  });
}

function collapseUi() {
  const pane = $("uiPane");
  const body = $("uiPaneBody");
  const frame = body && body.querySelector("iframe.live-ui");
  const home = uiExpanded && document.querySelector(`.ui-card[data-ui-key="${uiExpanded.key}"]`);
  signalLayout(frame, "inline");
  if (frame && home) home.appendChild(frame);
  if (home) home.classList.remove("expanded");
  document.body.classList.remove("ui-open");
  window.setTimeout(() => {
    if (!document.body.classList.contains("ui-open") && pane) pane.hidden = true;
  }, 220);
  uiExpanded = null;
  measureComposer();
}

function signalLayout(frame, mode) {
  if (!frame || !frame.contentWindow) return;
  if (mode === "fill") frame.style.height = "100%";
  else frame.style.removeProperty("height");
  const msg = { type: "ncli-ui", op: "layout", mode };
  frame.contentWindow.postMessage(msg, "*");
  requestAnimationFrame(() => {
    if (frame.contentWindow) frame.contentWindow.postMessage(msg, "*");
  });
}

function reattachUi() {
  if (!uiExpanded) return;
  const home = document.querySelector(`.ui-card[data-ui-key="${uiExpanded.key}"]`);
  const frame = $("uiPaneBody") && $("uiPaneBody").querySelector("iframe.live-ui");
  if (home && frame) {
    const stale = home.querySelector("iframe.live-ui");
    if (stale && stale !== frame) stale.remove();
    home.classList.add("expanded");
    signalLayout(frame, "fill");
  } else if (!frame) {
    collapseUi();
  }
}

function mermaidSvg(source) {
  const nodes = new Map();
  const edges = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || /^(graph|flowchart)\b/i.test(line)) continue;
    const edge = line.match(/^(\w+)(?:\[([^\]]+)\])?\s*-->\s*(\w+)(?:\[([^\]]+)\])?/);
    if (edge) {
      nodes.set(edge[1], edge[2] || nodes.get(edge[1]) || edge[1]);
      nodes.set(edge[3], edge[4] || nodes.get(edge[3]) || edge[3]);
      edges.push([edge[1], edge[3]]);
      continue;
    }
    const node = line.match(/^(\w+)\[([^\]]+)\]/);
    if (node) nodes.set(node[1], node[2]);
  }
  const ids = [...nodes.keys()];
  const w = Math.max(280, ids.length * 120);
  const boxes = ids.map((id, i) => {
    const x = 20 + i * 120;
    const label = escapeHtml(nodes.get(id) || id);
    return `<rect x="${x}" y="28" width="100" height="40" rx="8" fill="#161618" stroke="#262628"/><text x="${x + 50}" y="53" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#ececec">${label}</text>`;
  }).join("");
  const arrows = edges.map(([a, b]) => {
    const x1 = 20 + ids.indexOf(a) * 120 + 100;
    const x2 = 20 + ids.indexOf(b) * 120;
    return `<line x1="${x1}" y1="48" x2="${x2}" y2="48" stroke="#c2603d" marker-end="url(#ncli-arrow)"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 96" width="100%" height="96"><defs><marker id="ncli-arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#c2603d"/></marker></defs>${arrows}${boxes}</svg>`;
}

function jsxLite(source) {
  let s = source.trim()
    .replace(/^export default function \w+\(\)\s*\{/, "")
    .replace(/^function \w+\(\)\s*\{/, "")
    .replace(/\}\s*$/, "")
    .replace(/^\s*return\s*\(/, "")
    .replace(/\)\s*;?\s*$/, "")
    .replace(/\bclassName=/g, "class=")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\{(['"])(.*?)\1\}/g, "$2");
  return `<div>${s}</div>`;
}

function rich(s) {
  return escapeHtml(s)
    .replace(
      /view:\/\/([a-z0-9_-]+)(?:\?([^&\s<,]+))?/g,
      (_, id, q) => {
        const fork = state.forks.find((f) => f.view === id && f.status !== "merged");
        const label = fork ? `${id} #${fork.seq}` : id;
        return `<a class="vlink fl" data-view="${id}" data-q="${q || ""}">${escapeHtml(label)}</a>`;
      },
    )
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function timeOf(iso) {
  try {
    return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function busBody(text) {
  return String(text).replace(/^(Claude|Codex|Cursor|NCLI) → (Claude|Codex|Cursor|NCLI): (?:ask · )?/, "");
}

function avatar(seat) {
  const s = SEAT[seat] || SEAT.claude;
  const klass = seat === "claude" ? "cl" : seat === "codex" ? "cx" : "cu";
  return `<div class="av ${klass}"><img alt="" src="${s.src}"></div>`;
}

function renderChat() {
  const parts = [];
  const days = new Set(state.messages.map((m) => (m.date ? new Date(m.date).toDateString() : "")));
  const showDays = days.size > 1;
  let lastDay = "";
  let lastTalkAt = -1;
  for (let i = 0; i < state.messages.length; i++) {
    if (state.messages[i].kind === "talk") lastTalkAt = i;
  }
  for (let i = 0; i < state.messages.length; i++) {
    const m = state.messages[i];
    if (showDays) {
      const day = dayLabel(m.date);
      if (day !== lastDay) {
        parts.push(`<div class="day">${day}</div>`);
        lastDay = day;
      }
    }
    if (m.kind === "user") {
      parts.push(`<div class="u">${rich(m.text)}</div>`);
      continue;
    }
    if (m.kind === "tool") {
      parts.push(toolRowFromMessage(m));
      continue;
    }
    if (m.kind === "echo") continue;
    if (m.kind === "think") {
      parts.push(thinkBlock(m.seat || "claude", m.model, m.text, false, m.durationMs));
      continue;
    }
    if (m.kind === "merge") {
      parts.push(`<div class="ret">${md(m.text)}</div>`);
      continue;
    }
    if (m.kind === "note") {
      parts.push(`<div class="note">${md(m.text)}</div>`);
      continue;
    }
    const seat = m.seat || "claude";
    const nm = seat === "claude" ? "ncl" : seat === "codex" ? "ncx" : "ncu";
    const sm = m.kind === "seat" || m.kind === "bus" ? " sm" : "";
    const who = m.kind === "bus"
      ? busWho(m)
      : agentLabel(seat, m.model);
    parts.push(`<div class="m${sm}">${avatar(seat)}<div class="bb">
      <div class="nm ${nm}">${escapeHtml(who)}<span class="tm">${timeOf(m.date)}</span></div>
      <div class="md">${bodyHtml(m.kind === "bus" ? busBody(m.text) : m.text)}</div>
    </div></div>`);
    if (m.kind === "talk" && state.lastTurn && i === lastTalkAt) {
      parts.push(workDisclosure(state.lastTurn));
    }
  }
  if (state.turn && state.turn.status === "running") {
    parts.push(liveTurnHtml(state.turn));
  } else if (state.stream) {
    const seat = state.streamSeat || "claude";
    const nm = seat === "claude" ? "ncl" : seat === "codex" ? "ncx" : "ncu";
    parts.push(`<div class="m stream">${avatar(seat)}<div class="bb">
      <div class="nm ${nm}">${escapeHtml(agentLabel(seat, state.streamModel))}<span class="tm">…</span></div>
      <div class="md">${bodyHtml(state.stream, true)}</div>
    </div></div>`);
  }
  const keep = chat.scrollTop;
  log.innerHTML = parts.join("");
  reattachUi();
  measureComposer();
  if (stick.follow) chat.scrollTop = chat.scrollHeight;
  else chat.scrollTop = keep;
  paintScrollHints();
  renderChrome();
}

let liveRaf = 0;

function scheduleLivePaint() {
  if (liveRaf) return;
  liveRaf = requestAnimationFrame(() => {
    liveRaf = 0;
    paintLive();
  });
}

function paintLive() {
  const turn = state.turn;
  if (!turn || turn.status !== "running") {
    renderChat();
    return;
  }
  const html = liveTurnHtml(turn);
  const node = log.querySelector(":scope > .live.quiet");
  if (!node) {
    log.insertAdjacentHTML("beforeend", html);
  } else {
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const next = wrap.firstElementChild;
    if (next) node.replaceWith(next);
  }
  measureComposer();
  if (stick.follow) chat.scrollTop = chat.scrollHeight;
  paintScrollHints();
  renderChrome();
}

function paintTick() {
  if (!state.turn || state.turn.status !== "running") return;
  const q = quietOf(state.turn);
  const el = log.querySelector(".live.quiet .tdur");
  const phrase = log.querySelector(".live.quiet .shimmer-text");
  if (el) el.textContent = q.elapsed;
  if (phrase) phrase.textContent = q.phrase;
}

function paintScrollHints() {
  if (!chat) return;
  const top = chat.scrollTop;
  const max = Math.max(0, chat.scrollHeight - chat.clientHeight);
  chat.classList.toggle("can-up", top > 8);
  chat.classList.toggle("can-down", max - top > 8);
  const jump = $("jumpLatest");
  if (!jump) return;
  const show = !stick.follow && max > 8;
  jump.hidden = !show;
  jump.classList.toggle("show", show);
}

function jumpToLatest() {
  stick.follow = true;
  chat.scrollTop = chat.scrollHeight;
  paintScrollHints();
}

function measureComposer() {
  const el = $("form");
  if (!el) return;
  const box = el.getBoundingClientRect();
  const bottom = Number.parseFloat(getComputedStyle(el).bottom) || 28;
  const space = Math.max(box.height + bottom + 16, 96);
  document.documentElement.style.setProperty("--composer-space", `${space}px`);
}

function busWho(m) {
  const from = (SEAT[m.seat] || SEAT.claude).name;
  const to = m.to === "main" ? "NCLI" : ((SEAT[m.to] || {}).name || m.to || "NCLI");
  return `${from} → ${to}`;
}

function toolRowFromMessage(m) {
  const name = m.tool?.name || m.text;
  return `<div class="trow done"><span class="dot"></span><code>${escapeHtml(m.text || name)}</code></div>`;
}

function thinkBlock(seat, model, text, open, durationMs) {
  const dur = durationMs ? ` · ${Math.round(durationMs / 1000)}s` : "";
  return `<details class="think"${open ? " open" : ""}><summary>pensando${dur}</summary><div class="md">${md(text, open)}</div></details>`;
}

function liveTurnHtml(turn) {
  const q = quietOf(turn);
  const chips = (q.chips || []).map((c) => (
    `<span class="consult-chip">${avatar(c.seat)}${escapeHtml(c.label)}</span>`
  )).join("");
  const answer = q.answer
    ? `<div class="live-answer"><div class="md chunk">${bodyHtml(q.answer, true)}</div></div>`
    : "";
  return `<div class="live quiet" data-turn="${escapeHtml(turn.id)}">
    <div class="live-status"><span class="shimmer-text">${escapeHtml(q.phrase)}</span><span class="tdur">${escapeHtml(q.elapsed)}</span></div>
    ${chips ? `<div class="consult-chips">${chips}</div>` : ""}
    ${answer}
  </div>`;
}

function workDisclosure(turn) {
  const steps = (turn.steps || []).map((s) => stepHtml(s)).join("");
  const open = state.workOpen.has(turn.id) ? " open" : "";
  return `<div class="work-disc${open}" data-turn="${escapeHtml(turn.id)}">
    <button type="button" class="work-sum">${escapeHtml(workedOf(turn))}</button>
    <div class="work-panel"><div class="live-steps">${steps}</div></div>
  </div>`;
}

function quietOf(turn) {
  const steps = turn.steps || [];
  const running = [...steps].reverse().find((s) => s.status === "running") || steps[steps.length - 1];
  const answer = steps.filter((s) => s.kind === "text").map((s) => s.text).join("");
  const chips = [];
  const seen = new Set();
  for (const s of steps) {
    const other = s.kind === "ask" ? (s.to || s.seat) : s.seat;
    if (!other || other === turn.seat || seen.has(other)) continue;
    seen.add(other);
    chips.push({ seat: other, label: `consultou ${SEAT[other]?.name || other}` });
  }
  return {
    phrase: quietPhrase(running),
    elapsed: elapsedLabel(turn.startedAt),
    chips,
    answer,
  };
}

function quietPhrase(step) {
  if (!step) return "Trabalhando…";
  if (step.kind === "thinking") return "Pensando…";
  if (step.kind === "text") return "Escrevendo a resposta…";
  if (step.kind === "ask") {
    const to = step.to || step.seat;
    if (to === "codex") return "Consultando o Codex…";
    if (to === "claude") return "Consultando o Claude…";
    return "Consultando o Cursor…";
  }
  const name = step.tool?.name || step.title || step.to || "";
  if (/read|glob|grep|list|cat|ls\b|file/i.test(name)) return "Lendo o projeto…";
  if (/\bcursor\b/i.test(name)) return "Consultando o Cursor…";
  if (/\bcodex\b/i.test(name)) return "Consultando o Codex…";
  if (/bash|shell|cmd|exec|run/i.test(name)) return "Rodando um comando…";
  if (/write|edit|patch|apply/i.test(name)) return "Editando arquivos…";
  if (/web|fetch|search|http/i.test(name)) return "Pesquisando…";
  return "Trabalhando…";
}

function workedOf(turn) {
  const ms = Math.max(0, Date.parse(turn.endedAt || turn.lastEventAt || turn.startedAt) - Date.parse(turn.startedAt));
  const s = Math.max(1, Math.round(ms / 1000));
  const n = (turn.steps || []).length;
  return `Trabalhou por ${s}s · ${n} ${n === 1 ? "passo" : "passos"}`;
}

function stepHtml(s) {
  if (s.kind === "thinking") return thinkBlock(s.seat, s.model, s.text, s.status === "running");
  if (s.kind === "text") {
    return `<div class="m stream">${avatar(s.seat)}<div class="bb">
      <div class="nm ${s.seat === "claude" ? "ncl" : s.seat === "codex" ? "ncx" : "ncu"}">${escapeHtml(agentLabel(s.seat, s.model))}</div>
      <div class="md">${bodyHtml(s.text, s.status === "running")}</div>
    </div></div>`;
  }
  if (s.kind === "ask") {
    const inner = s.text ? `<div class="md nest">${md(s.text, s.status === "running")}</div>` : "";
    return `<div class="trow ${s.status} nest"><span class="dot"></span><code>${escapeHtml(s.title)}</code>${s.status === "running" ? '<span class="spin"></span>' : ""}</div>${inner}`;
  }
  const dur = s.endedAt ? ` · ${Math.max(0, Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 100) / 10)}s` : "";
  const body = s.detail
    ? `<details class="tout"><summary>saída${dur}</summary><pre>${escapeHtml(s.detail)}</pre></details>`
    : "";
  return `<div class="trow ${s.status}"><span class="dot"></span><code>${escapeHtml(s.title)}</code>${s.status === "running" ? '<span class="spin"></span>' : `<span class="tdur">${dur}</span>`}</div>${body}`;
}

function elapsedLabel(iso) {
  const ms = Math.max(0, Date.now() - Date.parse(iso || Date.now()));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function renderChrome() {
  const sw = $("agentSwitch");
  if (sw) {
    const main = state.main || { harness: "claude" };
    const seat = main.harness === "mock" ? "claude" : main.harness;
    const opts = [
      ["claude", "Claude"],
      ["codex", "Codex"],
      ["cursor", "Cursor"],
    ].map(([value, label]) => (
      `<button type="button" class="switch-opt${main.harness === value ? " on" : ""}" data-harness="${value}">${escapeHtml(label)}</button>`
    )).join("");
    sw.innerHTML = `<button type="button" class="switch-btn" id="switchBtn" aria-haspopup="listbox" aria-expanded="${state.switchOpen ? "true" : "false"}">
      ${avatar(seat)}<span>${escapeHtml(agentLabel(seat, main.model))}</span><span class="chev">▾</span>
    </button>
    <div class="switch-menu${state.switchOpen ? " open" : ""}" id="switchMenu" role="listbox">${opts}</div>`;
  }
  const c = $("compactInd");
  if (c && state.compact) {
    const k = Math.round((state.compact.tokensToday || 0) / 100) / 10;
    const b = Math.round((state.compact.budget || 0) / 1000);
    c.hidden = false;
    c.textContent = state.compact.running
      ? `compactando ${state.compact.lastNodes || 0} · ${k}k/${b}k`
      : `compact ${k}k/${b}k`;
  }
  const stop = $("stopBtn");
  if (stop) stop.hidden = !(state.turn && state.turn.status === "running");
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "hoje";
  if (d.toDateString() === yday.toDateString()) return "ontem";
  return d.toLocaleDateString("pt-BR");
}

const seenPills = new Set();

function renderShortcuts() {
  const pills = state.forks.filter((f) => f.status === "running" || f.status === "needs_user" || f.status === "done");
  const glyph = { review: "⌥", refino: "✎", live: "▣" };
  shortcuts.innerHTML = pills
    .map((f) => {
      const fresh = !seenPills.has(f.id);
      const attn = f.status === "needs_user" || f.status === "done";
      const klass = ["ch", fresh ? "pop" : "", attn ? "attn" : ""].filter(Boolean).join(" ");
      const n = f.needsUser?.count || (f.status === "done" ? 1 : 0);
      const sub = f.needsUser?.label || (f.status === "done" ? "pronto" : f.status === "running" ? "rodando" : f.title);
      const short = f.view === "refino" && f.needsUser?.count ? `${n} pergunta${n === 1 ? "" : "s"}` : sub;
      const badge = n ? `<span class="badge">${n}</span>` : "";
      return `<button class="${klass}" data-fork="${f.id}">
        <div class="lbl"><b>${escapeHtml(f.view)} #${f.seq}</b>${escapeHtml(short)}</div>
        <div class="fa">${glyph[f.view] || "●"}${badge}</div>
      </button>`;
    })
    .join("");
  for (const f of pills) seenPills.add(f.id);
}

function renderContext() {
  const ctx = state.context;
  const head = $("ctxHead");
  const list = $("ctxList");
  const cascade = $("ctxCascade");
  const tree = $("ctxTree");
  const raw = debugView;
  if (head && ctx) {
    const k = Math.round((ctx.compact?.tokensToday || 0) / 100) / 10;
    const b = Math.round((ctx.compact?.budget || ctx.budget || 0) / 1000);
    const model = ctx.compact?.model || "haiku";
    head.textContent = `${ctx.T} msgs · ${ctx.bytes}/${ctx.budget} · ${k}k/${b}k · ${model}`;
  } else if (head && state.debug) {
    const d = state.debug;
    head.textContent = `${d.bytes}/${d.budget} bytes · ${d.T ?? "?"} msgs · ${(d.levels || []).join(" ")}`;
  }
  if (raw) {
    raw.hidden = !state.ctxRaw;
    raw.textContent = ((ctx && rowLines(ctx.rows)) || (state.debug && state.debug.lines) || []).join("\n");
  }
  if (list) {
    list.hidden = state.ctxRaw || state.ctxTree;
    if (ctx) list.innerHTML = ctx.rows.map((row) => contextRowHtml(row)).join("");
  }
  if (cascade && ctx) cascade.innerHTML = cascadeHtml(ctx.rows);
  if (tree) {
    tree.hidden = !state.ctxTree || state.ctxRaw;
    if (state.ctxTree && ctx) tree.innerHTML = treeSvg(ctx.rows);
  }
  paintCtxMode();
  viewList.innerHTML = state.views
    .map((v) => `<li><code>view://${v.id}</code> · ${escapeHtml(v.label)} <span class="muted">${escapeHtml(v.file)}</span></li>`)
    .join("");
}

function rowLines(rows) {
  return (rows || []).map((r) => `${r.id}|${r.text}`);
}

function contextRowHtml(row) {
  const op = (state.ctxOps || []).find((o) => o.id === row.id || o.into === row.id);
  const enter = op && op.op === "add";
  const flash = op && (op.op === "update" || op.op === "merge");
  const klass = ["ctx-row", !row.built ? "pending" : "", enter ? "enter" : "", flash ? "flash" : ""].filter(Boolean).join(" ");
  const zoom = state.zoomId === row.id && state.zoomLines.length
    ? `<div class="ctx-zoom">${state.zoomLines.map((ln) => `<div>${escapeHtml(ln)}</div>`).join("")}</div>`
    : "";
  return `<button type="button" class="${klass}" data-start="${row.start}" data-n="${row.n}">
    <span class="ctx-badge" style="background:${badgeTone(row.n)}">x${row.n}</span>
    ${rowWhoHtml(row)}
    <span class="ctx-sum">${escapeHtml(row.summary || "")}</span>
    <span class="ctx-time">${escapeHtml(relativeTime(row.to || row.from))}</span>
  </button>${zoom}`;
}

function rowWhoHtml(row) {
  const a = row.author;
  if (!a || a.kind === "mix") return "";
  if (a.kind === "user") {
    const name = a.name || state.userName;
    return `<span class="ctx-who user"><span class="av user">${escapeHtml(authorInitial(name))}</span><b>${escapeHtml(name)}</b></span>`;
  }
  return `<span class="ctx-who agent">${avatar(a.seat)}<b>${escapeHtml(a.name)}</b></span>`;
}

function authorInitial(name) {
  const ch = [...String(name ?? "").trim()][0];
  return ch ? ch.toLocaleUpperCase("pt-BR") : "?";
}

function cascadeHtml(rows) {
  const by = new Map();
  for (const row of rows || []) {
    by.set(row.n, (by.get(row.n) || 0) + 1);
  }
  return [...by.keys()].sort((a, b) => a - b).map((n) => {
    const count = by.get(n);
    return `<span class="ctx-lane"><b>x${n}</b><em>${count} ${count === 1 ? "bloco" : "blocos"}</em></span>`;
  }).join("");
}

function paintCtxMode() {
  const mode = state.ctxRaw ? "raw" : state.ctxTree ? "tree" : "list";
  document.querySelectorAll("[data-ctx-mode]").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.ctxMode === mode);
  });
  const raw = $("ctxRaw");
  if (raw) raw.checked = state.ctxRaw;
}

function setCtxMode(mode) {
  state.ctxRaw = mode === "raw";
  state.ctxTree = mode === "tree";
  renderContext();
}

function setDrawer(open) {
  const d = $("drawer");
  const s = $("scrim");
  if (!d) return;
  d.hidden = !open;
  const wide = window.matchMedia("(min-width: 1100px)").matches;
  if (s) s.hidden = !open || wide;
  document.body.classList.toggle("drawer-open", open);
}

function treeSvg(rows) {
  const list = rows || [];
  const w = 360;
  const rowH = 36;
  const h = Math.max(40, list.length * rowH + 16);
  const nodes = list.map((row, i) => {
    const y = 12 + i * rowH;
    const x = 24 + Math.min(8, Math.log2(Math.max(1, row.n))) * 18;
    return { row, x, y, i };
  });
  const lines = [];
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (a.row.n < 2) continue;
    const half = a.row.n / 2;
    const kids = nodes.filter((n) => n.row.n === half && n.row.start >= a.row.start && n.row.start < a.row.start + a.row.n);
    for (const kid of kids) {
      const midY = (a.y + kid.y) / 2;
      lines.push(`<path d="M${a.x + 20} ${a.y + 18} V${midY} H${kid.x + 20} V${kid.y}" fill="none" stroke="${badgeTone(a.row.n)}" stroke-width="1.2"/>`);
    }
  }
  const boxes = nodes.map((n) => {
    const label = escapeHtml((n.row.summary || "").slice(0, 42));
    return `<g>
      <rect x="${n.x}" y="${n.y}" width="${w - n.x - 12}" height="28" rx="16" fill="#161618" stroke="#262628"/>
      <rect x="${n.x}" y="${n.y}" width="36" height="28" rx="6" fill="${badgeTone(n.row.n)}"/>
      <text x="${n.x + 18}" y="${n.y + 18}" text-anchor="middle" fill="#fff" font-size="10" font-family="ui-monospace,monospace">x${n.row.n}</text>
      <text x="${n.x + 44}" y="${n.y + 18}" fill="#d0d0d0" font-size="10" font-family="ui-monospace,monospace">${label}</text>
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" height="${h}">${lines.join("")}${boxes}</svg>`;
}

function badgeTone(n) {
  const stops = [[0, [61, 51, 48]], [2, [107, 74, 66]], [4, [154, 86, 72]], [6, [194, 96, 61]], [8, [143, 74, 54]]];
  const lv = Math.log2(Math.max(1, n));
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (lv >= stops[i][0] && lv <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const t = Math.min(1, Math.max(0, (lv - lo[0]) / span));
  return `#${lo[1].map((c, i) => Math.round(c + (hi[1][i] - c) * t).toString(16).padStart(2, "0")).join("")}`;
}

function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return "agora";
  if (s < 60) return `há ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d < 45) return `há ${d} d`;
  const mo = Math.round(d / 30);
  if (mo < 18) return `~${mo} ${mo === 1 ? "mês" : "meses"} atrás`;
  const y = Math.round(d / 365);
  return `~${y} ${y === 1 ? "ano" : "anos"} atrás`;
}

function diffContext(prev, next) {
  const prevById = new Map((prev || []).map((row) => [row.id, row]));
  const ops = [];
  for (const row of next || []) {
    const old = prevById.get(row.id);
    if (old) {
      if (old.text !== row.text || old.built !== row.built) ops.push({ op: "update", id: row.id });
      continue;
    }
    const half = row.n / 2;
    if (half >= 1 && Number.isInteger(half)) {
      const left = `${row.start}+${half}`;
      const right = `${row.start + half}+${half}`;
      if (prevById.has(left) && prevById.has(right)) {
        ops.push({ op: "merge", from: [left, right], into: row.id });
        continue;
      }
    }
    ops.push({ op: "add", id: row.id });
  }
  return ops;
}

async function openFork(id) {
  const keepTab = state.openFork === id && !overlay.hidden;
  const res = await fetch(`/api/forks/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  state.forkDetail = await res.json();
  state.openFork = id;
  const f = state.forkDetail.fork;
  if (f.status === "merged") {
    hideOverlay();
    return;
  }
  if (!keepTab) {
    const qTab = new URLSearchParams(location.search).get("tab");
    if (qTab === "Overview" || qTab === "Guide" || qTab === "Diff") state.forkTab = qTab;
    else state.forkTab = (f.ui && f.ui.tab) || (state.views.find((v) => v.id === f.view)?.tabs?.[0]) || "Guide";
  }
  overlay.hidden = false;
  document.body.classList.toggle("rv-open", f.view === "review");
  drawModal();
}

async function postAct(action) {
  if (!state.openFork) return;
  const id = state.openFork;
  const res = await fetch(`/api/forks/${encodeURIComponent(id)}/act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!res.ok) return;
  const data = await res.json();
  if (data.fork?.status === "merged") {
    hideOverlay();
    return;
  }
  await openFork(id);
}

function seatTrio(ui, fromLog) {
  const blurbs = ui.seats || [
    { seat: "claude", status: fromLog.claude ? "ok" : "run", text: fromLog.claude || "…" },
    { seat: "codex", status: fromLog.codex ? "ok" : "run", text: fromLog.codex || "—" },
    { seat: "cursor", status: fromLog.cursor ? "ok" : "run", text: fromLog.cursor || "—" },
  ];
  return `<div class="trio">${blurbs
    .map((b) => {
      const klass = b.seat === "claude" ? "cl" : b.seat === "codex" ? "cx" : "cu";
      const mark = b.status === "ok" ? `<span class="ok">✓</span>` : `<span class="run">…</span>`;
      const body = b.status === "run" ? `<span class="mute">${escapeHtml(b.text)}</span>` : escapeHtml(b.text);
      return `<div class="seat"><div class="h"><i class="d ${klass}"></i>${b.seat}${mark}</div>${body}</div>`;
    })
    .join("")}</div>`;
}

function cssId(path) {
  return String(path || "").replace(/[^a-zA-Z0-9]+/g, "-");
}

function hideOverlay() {
  overlay.hidden = true;
  overlay.classList.remove("rv");
  modal.classList.remove("rv");
  document.body.classList.remove("rv-open");
  state.openFork = null;
}

function bindGuidedReview(root) {
  const tab = state.forkTab || "Guide";
  root.querySelectorAll("[data-rv-panel]").forEach((p) => {
    p.hidden = p.dataset.rvPanel !== tab;
  });
  root.querySelectorAll(".tabs [data-tab]").forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === tab);
  });
  const cards = [...root.querySelectorAll("[data-rv-card]")];
  if (!cards.length || tab !== "Guide") return;
  const scroller = root.querySelector(".rv-body") || root;
  const sync = () => {
    const rect = scroller.getBoundingClientRect();
    let best = null;
    let bestOverlap = 0;
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(r.bottom, rect.bottom) - Math.max(r.top, rect.top));
      if (overlap > bestOverlap) {
        best = card.dataset.rvCard;
        bestOverlap = overlap;
      }
    }
    if (!best) best = cards[0].dataset.rvCard;
    root.querySelectorAll("[data-rv-file]").forEach((el) => {
      el.classList.toggle("on", el.dataset.rvFile === best);
    });
  };
  scroller.addEventListener("scroll", sync, { passive: true });
  sync();
}

function drawModal() {
  const detail = state.forkDetail;
  if (!detail) return;
  const view = detail.fork?.view;
  overlay.classList.toggle("rv", view === "review");
  modal.classList.toggle("rv", view === "review");
  if (detail.html) {
    modal.innerHTML = detail.html;
    if (view === "review") bindGuidedReview(modal);
    return;
  }
  const f = detail.fork;
  const ui = f.ui || {};
  const tabs = (state.views.find((v) => v.id === f.view)?.tabs) || ["Overview", "Guide", "Diff"];
  const fromLog = { claude: "", codex: "", cursor: "" };
  for (const m of detail.messages || []) {
    if (m.kind === "seat" && m.seat) fromLog[m.seat] = m.text;
    if (m.kind === "talk") fromLog.claude = m.text;
  }
  const chapters = ui.chapters || [];
  const prLabel = (f.title || "").replace(/^PR\s+(\d+).*/, "PR $1") || f.title;
  let body = "";
  if (state.forkTab === "Overview") {
    body = `<div>${escapeHtml(ui.overview || f.title)}</div>`;
  } else if (state.forkTab === "Diff") {
    const hunks = chapters.flatMap((c) => c.hunks || []);
    body = `<div class="diff">${hunks
      .map((h) => `<div class="${h.startsWith("+") ? "a" : "r"}">${escapeHtml(h)}</div>`)
      .join("") || "sem diff"}</div>`;
  } else {
    const focus =
      chapters.find((c) => (c.files || []).some((file) => /discount\.ts$/.test(file.path))) || chapters[0];
    const file = focus?.files?.[0];
    const hunks = (focus?.hunks || [])
      .map((h) => `<div class="${h.startsWith("+") ? "a" : "r"}">${escapeHtml(h)}</div>`)
      .join("");
    body = `<div>${escapeHtml(ui.overview || "")}</div>
      ${focus ? `<div>
        <div class="n">${String(focus.n).padStart(2, "0")} / ${String(focus.total).padStart(2, "0")}</div>
        <div style="font-weight:600;margin:2px 0 6px">${escapeHtml(focus.title)}</div>
        <div class="mute" style="margin-bottom:6px">${file ? `<code>${escapeHtml(file.path)}</code> <span class="ok">+${file.additions || 0}</span>` : ""}</div>
        <div class="diff">${hunks}</div>
        <div class="mute" style="margin-top:8px">${focus.reviewed ? "☑ revisado" : "☐ revisado"}</div>
      </div>` : ""}
      ${seatTrio(ui, fromLog)}`;
  }
  modal.innerHTML = `
    <div class="mh">
      <b>review #${f.seq}</b> ${escapeHtml(prLabel)} · <span class="run">rodando</span>
      ${f.worktree ? ` · <code>${escapeHtml(f.worktree)}</code>` : ""}
      <button class="x" id="closeModal" type="button">✕</button>
    </div>
    <div class="tabs">${tabs
      .map((t) => `<button data-tab="${t}" class="${t === state.forkTab ? "on" : ""}">${t}</button>`)
      .join("")}</div>
    <div class="mbody">${body}</div>
    <form class="mi" id="forkForm">
      <input name="t" placeholder="Fala com esse fork… (volta pro chat sozinho quando terminar)" autocomplete="off" />
    </form>`;
}

function applyEvent(ev) {
  switch (ev.type) {
    case "message":
      if (ev.session === "main") {
        state.stream = "";
        state.messages.push(ev.message);
        renderChat();
      } else if (state.openFork === ev.session && state.forkDetail) {
        state.forkDetail.messages = state.forkDetail.messages || [];
        state.forkDetail.messages.push(ev.message);
        drawModal();
      }
      break;
    case "delta":
      if (ev.session === "main" && ev.text) {
        state.stream = (state.stream || "") + ev.text;
        state.streamSeat = ev.seat || state.streamSeat;
        state.streamModel = ev.model || state.streamModel;
        scheduleLivePaint();
      }
      break;
    case "turn":
      if (ev.session === "main") {
        state.turn = ev.turn;
        if (ev.turn && ev.turn.status !== "running") {
          state.stream = "";
          if (ev.turn.status === "done" || ev.turn.status === "error" || ev.turn.status === "stopped") {
            state.lastTurn = ev.turn;
          }
          renderChat();
        } else {
          scheduleLivePaint();
        }
      } else {
        state.forkTurns[ev.session] = ev.turn;
        if (state.openFork === ev.session) drawModal();
      }
      break;
    case "step":
      if (ev.session === "main" && state.turn && ev.turnId === state.turn.id) {
        const i = (state.turn.steps || []).findIndex((s) => s.id === ev.step.id);
        if (i >= 0) state.turn.steps[i] = ev.step;
        else state.turn.steps.push(ev.step);
        scheduleLivePaint();
      }
      break;
    case "main":
      state.main = ev.main;
      renderChrome();
      break;
    case "compact":
      state.compact = ev.compact;
      renderChrome();
      break;
    case "fork": {
      const i = state.forks.findIndex((f) => f.id === ev.fork.id);
      if (i >= 0) state.forks[i] = ev.fork;
      else state.forks.push(ev.fork);
      renderShortcuts();
      renderChat();
      if (state.openFork === ev.fork.id) {
        if (ev.fork.status === "merged") {
          hideOverlay();
          break;
        }
        if (state.forkDetail) {
          state.forkDetail.fork = ev.fork;
          if (!state.forkDetail.html) drawModal();
        }
      }
      break;
    }
    case "views":
      state.views = ev.views;
      renderContext();
      break;
    case "debug":
      state.debug = ev;
      renderContext();
      break;
    case "hello":
      if (ev.userName) state.userName = ev.userName;
      break;
    case "context":
      if (ev.userName) state.userName = ev.userName;
      state.ctxOps = diffContext(state.ctxPrev, ev.rows || []);
      state.ctxPrev = ev.rows || [];
      state.context = ev;
      renderContext();
      break;
    default:
      break;
  }
}

$("stopBtn")?.addEventListener("click", () => {
  fetch("/api/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: "main" }) });
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest("#switchBtn");
  if (btn) {
    e.preventDefault();
    state.switchOpen = !state.switchOpen;
    renderChrome();
    return;
  }
  const opt = e.target.closest("[data-harness]");
  if (opt) {
    e.preventDefault();
    state.switchOpen = false;
    fetch("/api/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: opt.dataset.harness }),
    });
    renderChrome();
    return;
  }
  if (state.switchOpen && !e.target.closest(".agent-switch")) {
    state.switchOpen = false;
    renderChrome();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !state.switchOpen) return;
  state.switchOpen = false;
  renderChrome();
});

setInterval(() => {
  if (state.turn && state.turn.status === "running") paintTick();
}, 1000);

document.addEventListener("click", (e) => {
  const sum = e.target.closest(".work-sum");
  if (sum) {
    e.preventDefault();
    const id = sum.parentElement?.dataset?.turn;
    if (id) {
      if (state.workOpen.has(id)) state.workOpen.delete(id);
      else state.workOpen.add(id);
    }
    if (id && state.workOpen.has(id)) stick.follow = true;
    renderChat();
    return;
  }
  const row = e.target.closest(".ctx-row");
  if (row) {
    e.preventDefault();
    const start = Number(row.dataset.start);
    const n = Number(row.dataset.n);
    const id = `${start}+${n}`;
    if (state.zoomId === id) {
      state.zoomId = "";
      state.zoomLines = [];
      renderContext();
      return;
    }
    fetch(`/api/memory/zoom?id=${start}&n=${n}`).then((r) => r.json()).then((data) => {
      state.zoomId = id;
      state.zoomLines = data.ok ? data.lines : [data.error || "sem zoom"];
      renderContext();
    });
  }
});
document.querySelectorAll("[data-ctx-mode]").forEach((btn) => {
  btn.addEventListener("click", () => setCtxMode(btn.dataset.ctxMode));
});
$("ctxRaw")?.addEventListener("change", (e) => {
  setCtxMode(e.target.checked ? "raw" : "list");
});
chat.addEventListener("click", (e) => {
  const expand = e.target.closest(".ui-expand");
  if (expand) {
    e.preventDefault();
    const card = expand.closest(".ui-card");
    if (card) expandUi(card);
    return;
  }
  const a = e.target.closest(".vlink");
  if (!a) return;
  e.preventDefault();
  const id = a.dataset.view;
  const params = Object.fromEntries(new URLSearchParams(a.dataset.q || ""));
  const existing = state.forks.find((f) => f.view === id && f.status !== "merged");
  if (existing) {
    openFork(existing.id);
    return;
  }
  fetch("/api/forks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ view: id, params }),
  });
});

shortcuts.addEventListener("click", (e) => {
  const b = e.target.closest("[data-fork]");
  if (b) openFork(b.dataset.fork);
});

overlay.addEventListener("click", (e) => {
  const expand = e.target.closest?.(".ui-expand");
  if (expand) {
    e.preventDefault();
    const card = expand.closest(".ui-card");
    if (card) expandUi(card);
    return;
  }
  if (e.target === overlay || e.target.id === "closeModal") {
    hideOverlay();
    return;
  }
  const tab = e.target.closest?.("[data-tab]")?.dataset?.tab;
  if (tab) {
    state.forkTab = tab;
    drawModal();
    return;
  }
  const fileBtn = e.target.closest?.("[data-rv-file]");
  if (fileBtn) {
    const path = fileBtn.dataset.rvFile;
    document.getElementById(`file-${cssId(path)}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    modal.querySelectorAll("[data-rv-file]").forEach((el) => {
      el.classList.toggle("on", el.dataset.rvFile === path);
    });
    return;
  }
  const jump = e.target.closest?.("[data-rv-goto]");
  if (jump) {
    document.getElementById(jump.dataset.rvGoto)?.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  const fold = e.target.closest?.("tr.fold");
  if (fold) {
    let row = fold.nextElementSibling;
    const open = fold.classList.toggle("open");
    while (row && row.hasAttribute("data-fold-body")) {
      row.hidden = !open;
      row = row.nextElementSibling;
    }
    return;
  }
  const hunkBtn = e.target.closest?.("[data-rv-hunk]");
  if (hunkBtn) {
    const table = modal.querySelector(`table.rv-diff[data-file="${hunkBtn.dataset.file}"]`);
    if (!table) return;
    const rows = [...table.querySelectorAll("tr[data-hunk]")];
    const dir = hunkBtn.dataset.rvHunk;
    const visible = rows.find((r) => {
      const box = r.getBoundingClientRect();
      return box.top >= 80 && box.top < window.innerHeight - 80;
    });
    const cur = visible ? Number(visible.dataset.hunk) : 0;
    const targetN = dir === "next" ? cur + 1 : cur - 1;
    const dest = rows.find((r) => Number(r.dataset.hunk) === targetN) || (dir === "next" ? rows.at(-1) : rows[0]);
    dest?.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  const btn = e.target.closest("[data-act]");
  if (!btn || !state.openFork) return;
  const act = btn.dataset.act;
  if (act === "other") {
    const id = btn.dataset.id;
    const input = document.createElement("input");
    input.className = "other";
    input.placeholder = "outra…";
    btn.replaceWith(input);
    input.focus();
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      const value = input.value.trim();
      if (!value) return;
      postAct({ type: "answer", id, value });
    });
    return;
  }
  postAct({ type: act, id: btn.dataset.id, value: btn.dataset.value });
});

async function sendUser(text) {
  const t = String(text || "").trim();
  if (!t) return;
  await fetch("/api/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: t }),
  });
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  await sendUser(text);
});

window.addEventListener("message", (ev) => {
  const msg = parseUiHostMsg(ev.data);
  if (!msg) return;
  const frames = document.querySelectorAll("iframe.live-ui");
  const frame = [...frames].find((f) => f.contentWindow === ev.source);
  if (!frame) return;
  if (msg.op === "height") {
    if (uiExpanded && frame.closest(".ui-pane-body")) return;
    frame.style.height = `${msg.h}px`;
    return;
  }
  if (msg.op === "send") void sendUser(msg.text);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && uiExpanded) collapseUi();
});

$("uiCollapse")?.addEventListener("click", () => collapseUi());

overlay.addEventListener("submit", async (e) => {
  if (e.target.id !== "forkForm") return;
  e.preventDefault();
  const t = e.target.t.value.trim();
  if (!t || !state.openFork) return;
  e.target.t.value = "";
  const view = state.forkDetail?.fork?.view;
  if (view === "refino") {
    await postAct({ type: "say", value: t });
    return;
  }
  await fetch(`/api/forks/${encodeURIComponent(state.openFork)}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: t }),
  });
  if (state.openFork) await openFork(state.openFork);
});

$("menuBtn").addEventListener("click", () => {
  setDrawer($("drawer").hidden);
});
$("scrim").addEventListener("click", () => setDrawer(false));

chat.addEventListener("scroll", () => {
  stick.follow = chat.scrollHeight - chat.scrollTop - chat.clientHeight <= STICK_SLOP;
  paintScrollHints();
}, { passive: true });
$("jumpLatest")?.addEventListener("click", jumpToLatest);
window.addEventListener("resize", () => {
  measureComposer();
  if (stick.follow) chat.scrollTop = chat.scrollHeight;
  paintScrollHints();
});

async function boot() {
  const snap = await (await fetch("/api/state")).json();
  state.messages = snap.messages || [];
  state.forks = snap.forks || [];
  for (const f of state.forks) seenPills.add(f.id);
  state.views = snap.views || [];
  state.debug = snap.debug;
  state.context = snap.context || null;
  state.ctxPrev = (snap.context && snap.context.rows) || [];
  state.main = snap.main || state.main;
  state.lastTurn = snap.turn && snap.turn.status !== "running" ? snap.turn : null;
  state.turn = snap.turn || null;
  state.compact = snap.compact || null;
  renderChat();
  renderShortcuts();
  renderContext();
  const q = new URLSearchParams(location.search);
  const open = q.get("open");
  const tab = q.get("tab");
  if (tab === "Overview" || tab === "Guide" || tab === "Diff") state.forkTab = tab;
  if (open) await openFork(open);
  const ch = q.get("chapter");
  if (ch) document.getElementById(ch)?.scrollIntoView({ block: "start" });
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    try {
      applyEvent(JSON.parse(m.data));
    } catch {
      return;
    }
  };
}

boot();
