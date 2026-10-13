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
function readUiTokens() {
  const s = getComputedStyle(document.documentElement);
  const v = (name) => s.getPropertyValue(name).trim();
  return { bg: v("--bg"), card: v("--card"), line: v("--line"), fg: v("--fg"), muted: v("--muted"), accent: v("--accent") };
}
const UI_T = readUiTokens();
const seenMsgs = new Set();
let chatPrimed = false;
let scrollRaf = 0;
let overlayGen = 0;
let drawerGen = 0;
let pendingReviewOpen = null;
let programmaticScroll = false;
let lastScrollTop = 0;
let userUp = false;
let touchY = 0;

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function waitMotion(el) {
  if (!el || reducedMotion()) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (e) => {
      if (e.target === el) finish();
    };
    el.addEventListener("transitionend", onEnd);
    setTimeout(finish, 240);
  });
}

function setChatTop(top) {
  if (!chat) return;
  programmaticScroll = true;
  chat.scrollTop = top;
  programmaticScroll = false;
  lastScrollTop = chat.scrollTop;
}

function snapToFloor() {
  if (!chat) return;
  if (scrollRaf) {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
  }
  userUp = false;
  stick.follow = true;
  setChatTop(Math.max(0, chat.scrollHeight - chat.clientHeight));
}

function bindChatFloor() {
  if (!chat || !log || typeof ResizeObserver === "undefined") return;
  const ro = new ResizeObserver(() => {
    if (stick.follow) snapToFloor();
    paintScrollHints();
  });
  ro.observe(log);
  ro.observe(chat);
}

function markUserUp() {
  if (chat && chat.scrollTop > 0) userUp = true;
}

function dropStreamNode() {
  if (!log) return;
  for (const n of [...log.querySelectorAll(".m.stream")]) n.remove();
}

function followScroll() {
  if (!chat || !stick.follow) return;
  if (reducedMotion()) {
    const live = log.querySelector(".live.quiet, .m.stream");
    if (live) {
      const box = chat.getBoundingClientRect();
      const r = live.getBoundingClientRect();
      if (r.bottom > box.bottom - 24) setChatTop(chat.scrollTop + r.bottom - box.bottom + 24);
      return;
    }
    snapToFloor();
    return;
  }
  if (scrollRaf) return;
  const step = () => {
    if (!stick.follow) {
      scrollRaf = 0;
      return;
    }
    const target = chat.scrollHeight - chat.clientHeight;
    const cur = chat.scrollTop;
    const next = cur + (target - cur) * 0.22;
    if (Math.abs(target - next) < 0.6) {
      setChatTop(target);
      scrollRaf = 0;
      return;
    }
    setChatTop(next);
    scrollRaf = requestAnimationFrame(step);
  };
  scrollRaf = requestAnimationFrame(step);
}

function markEnter() {
  const nodes = log.querySelectorAll("[data-mid]");
  if (!chatPrimed) {
    nodes.forEach((el) => seenMsgs.add(el.dataset.mid));
    chatPrimed = true;
    return;
  }
  nodes.forEach((el) => {
    const id = el.dataset.mid;
    if (!id || seenMsgs.has(id)) return;
    seenMsgs.add(id);
    el.classList.add("enter");
    el.addEventListener("animationend", () => el.classList.remove("enter"), { once: true });
  });
}

const STATE_PAGE = 80;
const rowHtmlCache = new Map();

const state = {
  messages: [],
  sparks: [],
  views: [],
  waiting: [],
  messageCount: 0,
  before: null,
  hasMore: false,
  olderLoading: false,
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
  citeId: -1,
  lastTurn: null,
  openSpark: null,
  sparkTab: "Guide",
  sparkDetail: null,
  stream: "",
  streamSeat: "claude",
  streamModel: "",
  main: { harness: "claude", model: "" },
  turn: null,
  sparkTurns: {},
  compact: null,
  userName: "Você",
  queue: [],
  editQid: "",
  seats: [
    { harness: "claude" },
    { harness: "codex" },
    { harness: "cursor" },
  ],
  usage: { seats: [], chain: [] },
  import: null,
  importOffers: [],
  importProgress: {},
  jobStartedAt: {},
  jobFade: null,
  clis: { claude: false, codex: false, cursor: false },
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
  const re = /```ncli[ \t]+(mermaid|html|react|url|ui|3d)[ \t]*\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push(md(text.slice(last, m.index), false));
    segs.push(iframeFor(m[1], m[2].trim()));
    last = m.index + m[0].length;
  }
  const rest = text.slice(last);
  const open = rest.match(/```ncli[ \t]+(mermaid|html|react|url|ui|3d)[ \t]*\n([\s\S]*)$/);
  if (open && !open[2].includes("```")) segs.push(shimmerFor(open[1], open[2]));
  else if (rest) segs.push(md(rest, streaming));
  return segs.join("") || md(text, streaming);
}

const mdMemo = new Map();

function md(text, streaming) {
  if (!streaming && mdMemo.has(text)) {
    const hit = mdMemo.get(text);
    mdMemo.delete(text);
    mdMemo.set(text, hit);
    return hit;
  }
  const html = typeof renderMarkdown === "function" ? renderMarkdown(text, !!streaming) : rich(text);
  if (!streaming) {
    if (mdMemo.size > 400) mdMemo.delete(mdMemo.keys().next().value);
    mdMemo.set(text, html);
  }
  return html;
}

function shimmerFor(kind, source) {
  const shape = kind === "mermaid" ? "diagram" : kind === "url" ? "page" : kind === "3d" ? "scene" : kind === "react" || kind === "ui" ? "card" : /chart|canvas|svg|bar|plot/i.test(source || "") ? "chart" : "card";
  const label = shape === "diagram" ? "desenhando diagrama…" : shape === "chart" ? "desenhando gráfico…" : kind === "ui" ? "montando o card…" : kind === "react" ? "montando componente…" : kind === "3d" ? "montando a cena…" : shape === "page" ? "carregando página…" : "montando prévia…";
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

function sanitizeLiveMarkup(source) {
  return String(source || "")
    .replace(/<meta\b[^>]*>/gi, (tag) => (/refresh|url\s*=/i.test(tag) ? "" : tag))
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/\s(?:href|src|action|formaction|xlink:href|poster)\s*=\s*(['"])[\s\S]*?\1/gi, "")
    .replace(/\s(?:href|src|action|formaction|xlink:href|poster)\s*=\s*[^\s>]+/gi, "")
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
}

const LIVE_PRELUDE = `(function(){var n=["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection","RTCDataChannel"];for(var i=0;i<n.length;i++){try{Object.defineProperty(window,n[i],{configurable:false,enumerable:false,writable:false,value:undefined})}catch(e){try{window[n[i]]=undefined}catch(e2){}}}var create=Document.prototype.createElement;Document.prototype.createElement=function(name,opts){var el=create.call(this,name,opts);if(String(name).toLowerCase()==="meta"){var set=el.setAttribute.bind(el);el.setAttribute=function(k,v){if(/^http-equiv$/i.test(k)&&/refresh/i.test(String(v)))return;if(/^content$/i.test(k)&&/url=/i.test(String(v)))return;return set(k,v)}}return el};function strip(el){if(!el||el.nodeType!==1)return;if(el.hasAttribute("href")||el.hasAttribute("xlink:href")){el.removeAttribute("href");el.removeAttribute("xlink:href")}if(/^META$/i.test(el.tagName)){var eq=el.getAttribute("http-equiv")||"";if(/refresh/i.test(eq))el.remove()}}var desc=Object.getOwnPropertyDescriptor(Element.prototype,"innerHTML");if(desc&&desc.set){Object.defineProperty(Element.prototype,"innerHTML",{configurable:true,enumerable:desc.enumerable,get:desc.get,set:function(v){desc.set.call(this,v);strip(this);if(this.querySelectorAll)this.querySelectorAll("*").forEach(strip)}})}document.addEventListener("click",function(ev){var t=ev.target;while(t&&t.nodeType===1){if(t.hasAttribute&&(t.hasAttribute("href")||t.hasAttribute("xlink:href"))){ev.preventDefault();ev.stopPropagation();return}t=t.parentNode}},true);window.ncliFakes=function(){var loc={href:"",assign:function(){},replace:function(){},reload:function(){}};var win;var par=new Proxy(window.parent,{get:function(t,p){if(p==="location")return loc;var v=t[p];return typeof v==="function"?v.bind(t):v},set:function(t,p,v){if(p==="location")return true;t[p]=v;return true}});var doc=new Proxy(document,{get:function(t,p){if(p==="location")return loc;if(p==="defaultView")return win;var v=t[p];return typeof v==="function"?v.bind(t):v},set:function(t,p,v){if(p==="location")return true;t[p]=v;return true}});win=new Proxy(window,{get:function(t,p){if(p==="location")return loc;if(p==="document")return doc;if(p==="parent"||p==="top")return par;if(p==="window"||p==="self"||p==="globalThis"||p==="frames")return win;if(p==="Function"||p==="eval")return function(){return function(){}};var v=t[p];return typeof v==="function"?v.bind(t):v},set:function(t,p,v){if(p==="location")return true;t[p]=v;return true}});return [win,doc,loc,par,par,win,win,win,function(){return function(){}},function(){}]};function ping(op){try{parent.postMessage({type:"ncli-live",op:op,name:String(window.name||"")},"*")}catch(e){}}try{ping("hello")}catch(e3){}try{window.addEventListener("pagehide",function(){ping("nav")},true)}catch(e4){}})();`;

function wrapLiveScript(source) {
  return `(function(){var a=window.ncliFakes();return (function(window,document,location,top,parent,self,globalThis,frames,Function,eval){"use strict";${source}\n}).apply(a[0],a)})();`;
}

function compartmentHtml(body, extraHead) {
  const clean = sanitizeLiveMarkup(body);
  const scripts = [];
  const markup = clean.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_m, src) => {
    if (String(src).trim()) scripts.push(src);
    return "";
  });
  const wrapped = scripts.map((s) => `<script>${wrapLiveScript(s)}</script>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; navigate-to 'none'">${extraHead || ""}</head><body><script>${LIVE_PRELUDE}</script>${markup}${wrapped}</body></html>`;
}

function liveFrameSrc(html, klass, title) {
  const origin = window.NCLI_LIVE_ORIGIN || "";
  if (origin) {
    return `<iframe class="${klass}" name="${nextLiveFrameName()}" title="${title}" sandbox="allow-scripts" src="${escapeHtml(`${origin}/shell#${encodeURIComponent(html)}`)}"></iframe>`;
  }
  return `<iframe class="${klass}" name="${nextLiveFrameName()}" title="${title}" sandbox="allow-scripts" srcdoc="${html.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`;
}

let liveFrameSeq = 0;
function nextLiveFrameName() {
  liveFrameSeq += 1;
  return "ncliLive" + liveFrameSeq;
}

function iframeFor(kind, source) {
  try {
    if (kind === "url") {
      const href = httpHref(source);
      if (!href) return liveError(kind, source, "url bloqueada");
      return `<div class="live-wrap in live-url-ask" data-live-url="${escapeHtml(href)}"><p class="live-url-msg">Abrir <code>${escapeHtml(href)}</code>?</p><button type="button" class="live-url-go" data-href="${escapeHtml(href)}">abrir</button></div>`;
    }
    if (kind === "ui") {
      const key = uiKey(source);
      return `<div class="ui-card live-wrap in" data-ui-key="${key}"><button type="button" class="ui-expand" aria-label="Expandir">⤢</button>${liveFrameSrc(wrapUiSource(source), "live-frame live-ui", "live ui")}</div>`;
    }
    if (kind === "3d") {
      const origin = window.NCLI_LIVE_ORIGIN || "";
      const src = `${origin ? `${origin}/3d` : "/ncli3d.html"}#${encodeURIComponent(String(source || "").trim() || "ncli3d.desk()")}`;
      return `<div class="live-wrap in"><iframe class="live-frame live-3d" name="${nextLiveFrameName()}" title="live 3d" sandbox="allow-scripts" src="${escapeHtml(src)}"></iframe></div>`;
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
    const html = compartmentHtml(inner, `<style>${liveDocCss()}</style>`);
    return `<div class="live-wrap in">${liveFrameSrc(html, "live-frame", `live ${kind}`)}</div>`;
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
  return compartmentHtml(
    extractUiBody(source),
    `<style>${uiThemeCss()}</style><script>${uiLibScript()}</script><script>${uiHeightScript()}</script>`,
  );
}

const liveFrameHome = new WeakMap();
const composerWatch = new WeakMap();

function isConfirmedUrlFrame(iframe) {
  return iframe.getAttribute("data-live-kind") === "url";
}

function liveFrameFromEvent(ev) {
  const name = ev.data && typeof ev.data.name === "string" ? ev.data.name : "";
  for (const iframe of document.querySelectorAll("iframe.live-frame")) {
    if (isConfirmedUrlFrame(iframe)) continue;
    const home = liveFrameHome.get(iframe);
    if (name && iframe.name === name) return iframe;
    if (ev.source && iframe.contentWindow === ev.source) return iframe;
    if (ev.source && home && home.win === ev.source) return iframe;
  }
  return null;
}

function adoptLiveFrame(iframe, win) {
  if (isConfirmedUrlFrame(iframe)) return null;
  let home = liveFrameHome.get(iframe);
  if (!home) {
    home = {
      src: iframe.getAttribute("src") || "",
      win: win || iframe.contentWindow,
      dead: false,
      guarded: false,
    };
    liveFrameHome.set(iframe, home);
  } else if (!home.dead && win) {
    home.win = win;
  }
  return home;
}

function killLiveFrame(iframe) {
  const home = liveFrameHome.get(iframe) || adoptLiveFrame(iframe, iframe.contentWindow);
  if (!home || home.dead) return;
  home.dead = true;
  iframe.removeAttribute("src");
  iframe.srcdoc = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body></body></html>';
}

function killAllLiveFrames() {
  for (const iframe of document.querySelectorAll("iframe.live-frame")) {
    if (!isConfirmedUrlFrame(iframe)) killLiveFrame(iframe);
  }
}

function killLiveFrames(frame) {
  if (frame) {
    killLiveFrame(frame);
    return;
  }
  killAllLiveFrames();
}

function liveFrameAway(iframe) {
  const home = liveFrameHome.get(iframe);
  if (!home || home.dead) return false;
  const src = iframe.src || "";
  if (!/^https?:/i.test(src)) return false;
  if (!home.src) return true;
  try {
    return new URL(src).href !== new URL(home.src, location.href).href;
  } catch {
    return true;
  }
}

function guardLiveFrame(iframe) {
  if (isConfirmedUrlFrame(iframe)) return;
  const home = adoptLiveFrame(iframe, iframe.contentWindow);
  if (!home || home.guarded) return;
  home.guarded = true;
  iframe.addEventListener("load", () => {
    const next = liveFrameHome.get(iframe);
    if (next && !next.dead) next.win = iframe.contentWindow;
    if (liveFrameAway(iframe)) killLiveFrame(iframe);
  });
}

function bindLiveGuards(root) {
  const scope = root || document;
  for (const iframe of scope.querySelectorAll("iframe.live-frame")) {
    guardLiveFrame(iframe);
  }
}

function bindLiveUrlAsks(root) {
  const scope = root || document;
  for (const btn of scope.querySelectorAll(".live-url-go")) {
    if (btn.dataset.ncliBound) continue;
    btn.dataset.ncliBound = "1";
    btn.addEventListener("click", () => {
      const href = httpHref(btn.getAttribute("data-href") || "");
      const wrap = btn.closest(".live-url-ask");
      if (!href || !wrap) return;
      wrap.classList.remove("live-url-ask");
      wrap.innerHTML = `<iframe class="live-frame" data-live-kind="url" title="live url" sandbox="allow-scripts" src="${escapeHtml(href)}"></iframe>`;
    });
  }
}

function bind3dPause() {
  if (!log) return;
  if (!log._ncli3dObs) {
    log._ncli3dObs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const win = e.target.contentWindow;
        if (!win) continue;
        win.postMessage({ type: "ncli-3d", op: e.isIntersecting ? "resume" : "pause" }, "*");
      }
    }, { threshold: 0.08 });
  }
  for (const iframe of log.querySelectorAll("iframe.live-3d")) {
    log._ncli3dObs.observe(iframe);
  }
}

function live3dFrame(ev) {
  const name = ev.data && typeof ev.data.name === "string" ? ev.data.name : "";
  const frames = document.querySelectorAll("iframe.live-3d");
  for (const iframe of frames) {
    if (name && iframe.name === name) return iframe;
    try {
      if (ev.source && iframe.contentWindow === ev.source) return iframe;
    } catch {
      continue;
    }
  }
  return null;
}

window.addEventListener("message", (ev) => {
  const d0 = ev.data;
  if (d0 && d0.type === "ncli-live") {
    const frame = liveFrameFromEvent(ev);
    if (d0.op === "hello" && frame) adoptLiveFrame(frame, ev.source);
    if (d0.op === "nav") killLiveFrames(frame);
    return;
  }
  const iframe = live3dFrame(ev);
  if (!iframe) return;
  const d = ev.data;
  if (!d || d.type !== "ncli-3d") return;
  if (d.op === "ready") {
    iframe.dataset.ncli3dKind = d.kind || "";
    iframe.dataset.ncli3dBtns = (d.buttons || []).join("|");
    iframe.dataset.ncli3dEngine = d.engine || "";
    iframe.dataset.ncli3dTris = String(d.triangles ?? 0);
    return;
  }
  if (d.op === "wheel" && chat) {
    if (d.deltaY < 0) markUserUp();
    chat.scrollTop += Number(d.deltaY) || 0;
  }
});

function liveDocCss() {
  return `:root{--bg:${UI_T.bg};--card:${UI_T.card};--line:${UI_T.line};--fg:${UI_T.fg};--muted:${UI_T.muted};--accent:${UI_T.accent}}
html,body{margin:0;padding:8px;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,sans-serif}
a{color:var(--accent)}`;
}

function uiThemeCss() {
  return `:root{--bg:${UI_T.bg};--card:${UI_T.card};--line:${UI_T.line};--fg:${UI_T.fg};--muted:${UI_T.muted};--accent:${UI_T.accent}}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;overflow:hidden}
body{padding:16px 16px 18px}
*{box-sizing:border-box}
h1,h2,h3{font-size:15px;font-weight:600;margin:0 0 10px}
.muted,.hint{color:var(--muted)}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
.tabs button{appearance:none;border:0;background:transparent;color:var(--muted);padding:6px 10px;border-radius:999px;font:12px/1.2 inherit;cursor:pointer}
.tabs button.on{color:var(--fg);background:var(--card);box-shadow:inset 0 -2px 0 var(--accent)}
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
html.ui-fill body{display:flex;flex-direction:column;overflow:hidden}
html.ui-fill body>section:not([hidden]){flex:1;display:flex;flex-direction:column;min-height:0}
html.ui-fill #c1,html.ui-fill .ncli-chart-host{flex:1 1 auto;min-height:42vh;width:100%}
html.ui-fill .ncli-chart{height:100%;min-height:280px}`;
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
    window.setTimeout(() => signalLayout(frame, "fill"), 80);
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
  const pad = 16;
  const w = Math.max(280, ids.length * 120) + pad * 2;
  const boxes = ids.map((id, i) => {
    const x = pad + i * 120;
    const label = escapeHtml(nodes.get(id) || id);
    return `<rect x="${x}" y="${pad + 12}" width="100" height="40" rx="8" fill="${UI_T.card}" stroke="${UI_T.line}"/><text x="${x + 50}" y="${pad + 37}" text-anchor="middle" font-size="12" font-family="sans-serif" fill="${UI_T.fg}">${label}</text>`;
  }).join("");
  const arrows = edges.map(([a, b]) => {
    const x1 = pad + ids.indexOf(a) * 120 + 100;
    const x2 = pad + ids.indexOf(b) * 120;
    return `<line x1="${x1}" y1="${pad + 32}" x2="${x2}" y2="${pad + 32}" stroke="${UI_T.accent}" marker-end="url(#ncli-arrow)"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${80 + pad * 2}" width="100%" height="${80 + pad * 2}"><defs><marker id="ncli-arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${UI_T.accent}"/></marker></defs>${arrows}${boxes}</svg>`;
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
        const spark = state.sparks.find((f) => f.view === id && f.status !== "merged");
        const label = spark ? `${id} #${spark.seq}` : id;
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

function importChipLabel(src) {
  const names = { claude: "Claude", codex: "Codex", cursor: "Cursor" };
  const p = state.importProgress && state.importProgress[src];
  if (!p) return `trazer ${names[src] || src}`;
  return `lendo ${p.done || 0} de ${p.total || 1}`;
}

function paintImportChip(btn, src) {
  const p = state.importProgress && state.importProgress[src];
  btn.textContent = importChipLabel(src);
  if (p) {
    btn.disabled = true;
    btn.classList.add("is-importing");
    btn.style.removeProperty("--import-pct");
  } else {
    btn.disabled = false;
    btn.classList.remove("is-importing");
    btn.style.removeProperty("--import-pct");
  }
}

function welcomeImportActions() {
  const offers = state.importOffers || [];
  const sources = offers.length
    ? offers.map((o) => o.source)
    : state.import
      ? [state.import.source]
      : [];
  if (!sources.length) return "";
  return `<div class="welcome-actions">${sources
    .map((src) => {
      const p = state.importProgress && state.importProgress[src];
      const busy = p ? ` disabled class="welcome-go is-importing"` : ` class="welcome-go"`;
      return `<button type="button"${busy} data-welcome-import="${escapeHtml(src)}">${escapeHtml(importChipLabel(src))}</button>`;
    })
    .join("")}</div>`;
}

function renderChat() {
  syncChat();
}

function messageMid(m, i) {
  return `${m.i ?? i}:${m.kind}:${m.date || ""}`;
}

function rowSig(m) {
  return `${m.i}|${m.kind}|${m.date || ""}|${m.text}|${m.seat || ""}|${m.model || ""}|${m.durationMs || ""}`;
}

function cachedRowHtml(m, mid) {
  const sig = rowSig(m);
  const hit = rowHtmlCache.get(mid);
  if (hit && hit.sig === sig) return hit.html;
  const html = messageRowHtml(m, mid);
  rowHtmlCache.set(mid, { sig, html });
  if (rowHtmlCache.size > 400) rowHtmlCache.delete(rowHtmlCache.keys().next().value);
  return html;
}

function elFromHtml(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  return wrap.firstElementChild;
}

function captureAnchor() {
  if (!chat) return { floor: true };
  const leftover = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  if (stick.follow || leftover <= STICK_SLOP) return { floor: true };
  const box = chat.getBoundingClientRect();
  for (const n of log.querySelectorAll(":scope > [data-mid]")) {
    const r = n.getBoundingClientRect();
    if (r.bottom > box.top + 8) return { floor: false, mid: n.dataset.mid, offset: r.top - box.top };
  }
  return { floor: false, mid: null, offset: chat.scrollTop };
}

function restoreAnchor(anchor) {
  if (!anchor || !chat) return;
  if (anchor.floor) {
    snapToFloor();
    return;
  }
  if (anchor.mid) {
    const node = log.querySelector(`[data-mid="${CSS.escape(anchor.mid)}"]`);
    if (node) {
      const box = chat.getBoundingClientRect();
      setChatTop(chat.scrollTop + (node.getBoundingClientRect().top - box.top) - anchor.offset);
      return;
    }
  }
}

function desiredChatRows() {
  const rows = [];
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
        rows.push({ mid: `day:${day}`, sig: day, html: `<div class="day" data-mid="day:${day}">${day}</div>` });
        lastDay = day;
      }
    }
    if (m.kind === "echo") continue;
    if (/^tools:\s/i.test(m.text)) continue;
    const mid = messageMid(m, i);
    rows.push({ mid, sig: rowSig(m), html: cachedRowHtml(m, mid) });
    if (m.kind === "talk" && state.lastTurn && i === lastTalkAt) {
      const wid = `work:${state.lastTurn.id}`;
      rows.push({ mid: wid, sig: `${state.lastTurn.id}|${state.lastTurn.endedAt || ""}`, html: workDisclosure(state.lastTurn) });
    }
  }
  return rows;
}

function syncChat() {
  if (chromeNow().showWelcome) {
    log.classList.remove("from-welcome");
    if (!log.querySelector(".welcome")) {
      log.innerHTML = `<div class="welcome"><p>O mesmo Claude do CLI.</p><p class="welcome-hint">Escreve uma pergunta, cola o URL de um PR, ou /help</p>${welcomeImportActions()}</div>`;
    } else {
      const actions = log.querySelector(".welcome-actions");
      const next = welcomeImportActions();
      if (actions && next) actions.outerHTML = next;
      else if (!actions && next) log.querySelector(".welcome")?.insertAdjacentHTML("beforeend", next);
    }
    paintScrollHints();
    renderChrome();
    return;
  }
  const anchor = captureAnchor();
  if (log.querySelector(".welcome")) log.replaceChildren();
  const desired = desiredChatRows();
  const byMid = new Map();
  for (const n of [...log.querySelectorAll(":scope > [data-mid]")]) byMid.set(n.dataset.mid, n);
  const next = [];
  let created = false;
  for (const row of desired) {
    const cur = byMid.get(row.mid);
    if (cur && cur.dataset.sig === row.sig) {
      next.push(cur);
      byMid.delete(row.mid);
      continue;
    }
    const el = elFromHtml(row.html);
    if (el) {
      el.dataset.sig = row.sig;
      next.push(el);
      created = true;
    }
    if (cur) byMid.delete(row.mid);
  }
  for (const n of byMid.values()) n.remove();
  let ptr = log.firstChild;
  while (ptr && !ptr.hasAttribute?.("data-mid") && !ptr.classList?.contains("live") && !ptr.classList?.contains("stream")) {
    const gone = ptr;
    ptr = ptr.nextSibling;
    gone.remove();
  }
  for (const el of next) {
    if (ptr !== el) log.insertBefore(el, ptr);
    ptr = el.nextSibling;
  }
  if (state.turn && state.turn.status === "running") paintLive();
  else if (state.stream) {
    const seat = state.streamSeat || "claude";
    const nm = seat === "claude" ? "ncl" : seat === "codex" ? "ncx" : "ncu";
    const html = `<div class="m stream">${avatar(seat)}<div class="bb">
      <div class="nm ${nm}">${escapeHtml(agentLabel(seat, state.streamModel))}<span class="tm">…</span></div>
      <div class="md">${bodyHtml(state.stream, true)}</div>
    </div></div>`;
    const node = log.querySelector(":scope > .m.stream");
    if (!node) log.insertAdjacentHTML("beforeend", html);
    else {
      const fresh = elFromHtml(html);
      if (fresh) node.replaceWith(fresh);
    }
  } else {
    dropStreamNode();
  }
  if (created) {
    reattachUi();
    bindLiveGuards(log);
    bindLiveUrlAsks(log);
    bind3dPause();
    markEnter();
  }
  restoreAnchor(anchor);
  paintScrollHints();
  renderChrome();
}

function applyMessagePage(page) {
  if (Array.isArray(page.messages)) state.messages = page.messages;
  if (page.before !== undefined) state.before = page.before;
  if (page.hasMore != null) state.hasMore = Boolean(page.hasMore);
  if (page.messageCount != null) state.messageCount = page.messageCount;
}

function trimFollowWindow() {
  if (!stick.follow || state.messages.length <= STATE_PAGE) return;
  const extra = state.messages.length - STATE_PAGE;
  state.messages = state.messages.slice(extra);
  state.hasMore = true;
  const first = state.messages[0];
  state.before = first && first.i >= 0 ? first.i : state.before;
}

async function loadOlder() {
  if (!state.hasMore || state.olderLoading || state.before == null) return;
  state.olderLoading = true;
  const before = state.before;
  const anchor = captureAnchor();
  try {
    const snap = await (await fetch(`/api/state?before=${encodeURIComponent(String(before))}&limit=${STATE_PAGE}`)).json();
    const have = new Set(state.messages.map((m) => m.i));
    const older = (snap.messages || []).filter((m) => !have.has(m.i));
    if (older.length) state.messages = [...older, ...state.messages];
    state.before = snap.before ?? null;
    state.hasMore = Boolean(snap.hasMore);
    if (snap.messageCount != null) state.messageCount = snap.messageCount;
    syncChat();
    restoreAnchor(anchor);
  } finally {
    state.olderLoading = false;
  }
}

function messageRowHtml(m, mid) {
  const attr = `data-mid="${escapeHtml(mid)}"`;
  if (m.kind === "user") {
    return `<div class="u" ${attr}>${rich(m.text)}</div>`;
  }
  if (m.kind === "tool") return `<div class="twrap" ${attr}>${toolRowFromMessage(m)}</div>`;
  if (m.kind === "echo") return "";
  if (m.kind === "think") return `<div class="thwrap" ${attr}>${thinkBlock(m.seat || "claude", m.model, m.text, false, m.durationMs)}</div>`;
  if (m.kind === "merge") {
    return `<div class="ret" ${attr}>${md(m.text)}</div>`;
  }
  if (m.kind === "note") {
    if (/^tools:\s/i.test(m.text)) return "";
    const warn = /limite|quota/i.test(m.text);
    return `<div class="note${warn ? " warn" : ""}" ${attr}>${md(m.text)}</div>`;
  }
  const seat = m.seat || "claude";
  const nm = seat === "claude" ? "ncl" : seat === "codex" ? "ncx" : "ncu";
  const sm = m.kind === "seat" || m.kind === "bus" ? " sm" : "";
  const who = m.kind === "bus" ? busWho(m) : agentLabel(seat, m.model);
  const chips = m.kind === "talk" ? recallChipHtml(m.recall) : "";
  return `<div class="m${sm}" ${attr}>${avatar(seat)}<div class="bb">
      <div class="nm ${nm}">${escapeHtml(who)}<span class="tm">${timeOf(m.date)}</span></div>
      <div class="md">${bodyHtml(m.kind === "bus" ? busBody(m.text) : m.text)}</div>
      ${chips}
    </div></div>`;
}

let liveRaf = 0;
let fullRaf = 0;

function scheduleLivePaint() {
  if (liveRaf) return;
  liveRaf = requestAnimationFrame(() => {
    liveRaf = 0;
    paintLive();
  });
}

function scheduleFullPaint() {
  if (fullRaf) return;
  fullRaf = requestAnimationFrame(() => {
    fullRaf = 0;
    renderChat();
  });
}

function paintLive() {
  const turn = state.turn;
  if (!turn || turn.status !== "running") {
    dropStreamNode();
    renderChat();
    paintScrollHints();
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
  if (stick.follow) followScroll();
  paintScrollHints();
}

function paintTick() {
  if (!state.turn || state.turn.status !== "running") return;
  const q = quietOf(state.turn);
  const live = log.querySelector(".live.quiet");
  const el = live && live.querySelector(".tdur");
  const phrase = live && live.querySelector(".shimmer-text");
  if (el) el.textContent = q.elapsed;
  if (phrase) phrase.textContent = q.phrase;
  if (live) {
    if (q.stuck) live.setAttribute("data-stuck", "1");
    else live.removeAttribute("data-stuck");
  }
}

function paintScrollHints() {
  if (!chat) return;
  const top = chat.scrollTop;
  const max = Math.max(0, chat.scrollHeight - chat.clientHeight);
  const view = chat.clientHeight;
  chat.classList.toggle("can-up", top > 8);
  chat.classList.toggle("can-down", max - top > 8);
  const jump = $("jumpLatest");
  if (!jump) return;
  const streaming = Boolean(state.turn && state.turn.status === "running");
  const live = log.querySelector(".live.quiet, .m.stream");
  let streamOff = false;
  if (streaming && live) {
    const r = live.getBoundingClientRect();
    const box = chat.getBoundingClientRect();
    streamOff = r.bottom > box.bottom - 8 || r.top > box.bottom;
  }
  const far = max - top > view;
  const show = (!stick.follow && far) || streamOff;
  jump.hidden = !show;
  jump.classList.toggle("show", show);
  jump.classList.toggle("live", streamOff);
  jump.textContent = streamOff && !stick.follow ? "↓ resposta em curso" : "↓ agora";
}

function jumpToLatest() {
  userUp = false;
  stick.follow = true;
  followScroll();
  paintScrollHints();
}

let lastComposerSpace = -1;
function watchComposer() {
  const el = $("dock") || $("form");
  if (!el || composerWatch.has(el)) return;
  const ro = new ResizeObserver(() => measureComposer());
  ro.observe(el);
  composerWatch.set(el, ro);
  measureComposer();
}

function measureComposer() {
  if (typeof window !== "undefined" && typeof window.__ncliComposerMeasures === "number") window.__ncliComposerMeasures += 1;
  const el = $("dock") || $("form");
  if (!el) return;
  const box = el.getBoundingClientRect();
  const bottom = Number.parseFloat(getComputedStyle(el).bottom) || 28;
  const space = Math.max(box.height + bottom + 16, 96);
  if (space === lastComposerSpace) return;
  lastComposerSpace = space;
  document.documentElement.style.setProperty("--composer-space", `${space}px`);
}

function reviewPasteHint(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const m = t.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  return m ? { owner: m[1], repo: m[2], pr: m[3] } : null;
}

function isLonePrUrl(text) {
  return /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/[^\s?#]*)?(?:[?#]\S*)?$/i.test(
    String(text || "").trim(),
  );
}

function sameReviewParams(a, b) {
  if (!a || !b) return false;
  if (String(a.pr || "") !== String(b.pr || "")) return false;
  if (a.owner && b.owner && a.owner !== b.owner) return false;
  if (a.repo && b.repo && a.repo !== b.repo) return false;
  return true;
}

function renderPasteHint() {
  const bar = $("phint");
  if (!bar) return;
  const value = input && input.value;
  if (!value || !/github\.com\//i.test(value)) {
    if (!bar.hidden) {
      bar.hidden = true;
      bar.innerHTML = "";
      measureComposer();
    }
    return;
  }
  const hint = reviewPasteHint(value);
  if (!hint) {
    if (!bar.hidden) {
      bar.hidden = true;
      bar.innerHTML = "";
      measureComposer();
    }
    return;
  }
  bar.hidden = false;
  bar.innerHTML = `<div class="qitem" data-pr-hint="${escapeHtml(hint.pr)}"><span>review</span><b>Enter abre o spark #${escapeHtml(hint.pr)}</b></div>`;
  measureComposer();
}

function openPendingReview(spark) {
  if (!pendingReviewOpen || !spark || spark.view !== "review") return false;
  if (!sameReviewParams(spark.params, pendingReviewOpen)) return false;
  pendingReviewOpen = null;
  void openSpark(spark.id);
  return true;
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
  return `<div class="live quiet" data-turn="${escapeHtml(turn.id)}"${q.stuck ? " data-stuck=\"1\"" : ""}>
    <div class="live-status"><span class="shimmer-text">${escapeHtml(q.phrase)}</span><span class="tdur">${escapeHtml(q.elapsed)}</span></div>
    ${chips ? `<div class="consult-chips">${chips}</div>` : ""}
    ${answer}
  </div>`;
}

function workDisclosure(turn) {
  const steps = (turn.steps || []).map((s) => stepHtml(s)).join("");
  const open = state.workOpen.has(turn.id) ? " open" : "";
  return `<div class="work-disc${open}" data-mid="work:${escapeHtml(turn.id)}" data-turn="${escapeHtml(turn.id)}">
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
  const silent = Math.max(0, Date.now() - Date.parse(turn.lastEventAt || turn.startedAt));
  const stuck = turn.status === "running" && silent >= 5000;
  return {
    phrase: stuck ? stuckPhrase(turn.seat) : quietPhrase(running),
    elapsed: elapsedLabel(turn.startedAt),
    chips,
    answer,
    stuck,
  };
}

function stuckPhrase(seat) {
  if (seat === "codex") return "Sem resposta do Codex. O processo ainda não enviou tokens.";
  if (seat === "cursor") return "Sem resposta do Cursor. O processo ainda não enviou tokens.";
  return "Sem resposta do Claude. O processo ainda não enviou tokens.";
}

function quietPhrase(step) {
  if (!step) return "Pensando…";
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
  if (ms < 10000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function setSwitchOpen(open) {
  state.switchOpen = open;
  const menu = $("switchMenu");
  const btn = $("switchBtn");
  if (menu && btn) {
    menu.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    return;
  }
  renderChrome();
}

function jobPctOf(done, total) {
  if (total <= 0) return done > 0 ? 100 : null;
  return Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
}

function jobEtaMsOf(job, now) {
  if (job.phase !== "running" || job.startedAt <= 0 || job.done < 2 || job.total <= job.done) return null;
  const elapsed = now - job.startedAt;
  if (elapsed < 800) return null;
  const rate = job.done / elapsed;
  if (rate <= 0) return null;
  return Math.round((job.total - job.done) / rate);
}

function jobEtaLabelOf(ms) {
  if (ms === null) return "";
  if (ms < 5000) return "~alguns segundos";
  if (ms < 60000) return `~${Math.round(ms / 1000)}s`;
  const min = Math.max(1, Math.round(ms / 60000));
  return min === 1 ? "~1 min" : `~${min} min`;
}

function compactSpendLabelOf(tokensToday, budget) {
  if (!(budget > 0)) return null;
  const k = Math.round((tokensToday || 0) / 100) / 10;
  const b = Math.round(budget / 1000);
  return `${k}k/${b}k`;
}

function jobSourceName(src) {
  return src === "codex" ? "Codex" : src === "cursor" ? "Cursor" : "Claude";
}

function jobStageOf(job) {
  if (job.kind === "import") {
    const name = jobSourceName(job.source);
    if (job.phase === "done") return `Histórico do ${name} pronto`;
    if (job.phase === "error") return `Não deu pra ler o histórico do ${name}`;
    return `Lendo seu histórico do ${name}`;
  }
  if (job.phase === "done") return "Memória organizada";
  if (job.phase === "error") return "Não deu pra organizar a memória";
  if (job.phase === "paused") return "Pausado: limite diário";
  return "Organizando a memória";
}

function jobLineOf(job) {
  const stage = jobStageOf(job);
  if (job.phase === "paused") {
    const bits = [stage];
    const pct = jobPctOf(job.done, job.total);
    if (pct !== null) bits.push(`${pct}%`);
    bits.push("continua amanhã");
    return bits.join(" · ");
  }
  if (job.phase !== "running") return stage;
  const bits = [stage];
  if (job.kind === "import" && job.total > 0) {
    bits.push(`${job.done} de ${job.total} ${job.total === 1 ? "conversa" : "conversas"}`);
  } else {
    const pct = jobPctOf(job.done, job.total);
    if (pct !== null) bits.push(`${pct}%`);
  }
  return bits.join(" · ");
}

function jobMetaOf(job, now) {
  if (job.phase !== "running") return "";
  const bits = [];
  if (job.kind === "import") {
    const pct = jobPctOf(job.done, job.total);
    if (pct !== null) bits.push(`${pct}%`);
  }
  const eta = jobEtaLabelOf(jobEtaMsOf(job, now));
  if (eta) bits.push(eta);
  return bits.join(" · ");
}

function markJobStart(key) {
  if (!state.jobStartedAt[key]) state.jobStartedAt[key] = Date.now();
  return state.jobStartedAt[key];
}

function clearJobStart(key) {
  delete state.jobStartedAt[key];
}

function activeJob() {
  const srcs = Object.keys(state.importProgress || {});
  const src = srcs[0];
  const p = src && state.importProgress[src];
  if (p) {
    const total = p.total || 0;
    const done = p.done || 0;
    const phase = p.error ? "error" : total > 0 && done >= total ? "done" : "running";
    return {
      kind: "import",
      phase,
      source: src,
      done,
      total,
      startedAt: markJobStart(`import:${src}`),
      error: p.error || "",
    };
  }
  const c = state.compact;
  if (c && (c.running || c.error || c.paused || state.jobFade === "compact")) {
    const phase = c.error ? "error" : c.paused === "budget" ? "paused" : c.running ? "running" : "done";
    if (phase === "running") markJobStart("compact");
    return {
      kind: "compact",
      phase,
      done: c.done || 0,
      total: c.total || 0,
      startedAt: state.jobStartedAt.compact || Date.now(),
      error: c.error || "",
    };
  }
  return null;
}

function renderJob() {
  const el = $("jobInd");
  if (!el) return;
  const job = activeJob();
  if (!job) {
    if (el.hidden && !el.innerHTML) return;
    el.hidden = true;
    el.innerHTML = "";
    el.removeAttribute("data-phase");
    el.removeAttribute("data-kind");
    el.removeAttribute("data-unknown");
    el.classList.remove("is-out", "is-in");
    return;
  }
  const now = Date.now();
  const pct = jobPctOf(job.done, job.total);
  const unknown = job.phase === "running" && pct === null;
  const line = jobLineOf(job);
  const meta = jobMetaOf(job, now);
  el.style.setProperty("--job-pct", unknown ? "0.28" : String((pct ?? 0) / 100));
  if (unknown) el.dataset.unknown = "1";
  else delete el.dataset.unknown;
  el.classList.toggle("is-out", job.phase === "done");
  el.classList.add("is-in");
  const stage = el.querySelector(".job-stage");
  const metaEl = el.querySelector(".job-meta");
  if (!el.hidden && el.dataset.kind === job.kind && el.dataset.phase === job.phase && stage) {
    if (stage.textContent !== line) stage.textContent = line;
    if (metaEl && metaEl.textContent !== (meta || "")) metaEl.textContent = meta || "";
    return;
  }
  const retry = job.phase === "error"
    ? `<button type="button" class="job-retry" data-job-retry="${escapeHtml(job.kind)}" data-job-source="${escapeHtml(job.source || "")}">tentar de novo</button>`
    : "";
  el.hidden = false;
  el.dataset.phase = job.phase;
  el.dataset.kind = job.kind;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `<div class="job-track" aria-hidden="true"><div class="job-fill"></div></div><div class="job-copy"><span class="job-stage">${escapeHtml(line)}</span>${meta ? `<span class="job-meta">${escapeHtml(meta)}</span>` : ""}</div>${retry}`;
}

function agentTrio(clis, mainHarness) {
  const main = mainHarness === "codex" || mainHarness === "cursor" ? mainHarness : "claude";
  return ["claude", "codex", "cursor"].map((seat) => {
    const present = Boolean(clis && clis[seat]);
    return {
      seat,
      present,
      main: seat === main && present,
    };
  });
}

function sessionChrome(input) {
  const sparked = input.sparkCount > 0;
  return {
    showSwitcher: true,
    showCompact: input.compactRunning,
    showSparks: sparked,
    showViews: sparked,
    showWelcome: input.messageCount === 0,
  };
}

function chromeNow() {
  const seats = (state.usage && state.usage.seats) || [];
  const progress = state.importProgress || {};
  return sessionChrome({
    messageCount: state.messageCount || state.messages.length,
    sparkCount: state.sparks.length,
    compactTokens: state.compact ? state.compact.tokensToday || 0 : 0,
    compactRunning: Boolean(state.compact && state.compact.running),
    limited: seats.some((s) => s.status === "limited"),
    mainHarness: (state.main && state.main.harness) || "claude",
    importing: Object.keys(progress).length > 0,
  });
}

function renderChrome() {
  const chrome = chromeNow();
  const sw = $("agentSwitch");
  if (sw) {
    const main = state.main || { harness: "claude" };
    const seat = main.harness === "mock" ? "claude" : main.harness;
    const seats = state.seats && state.seats.length
      ? state.seats
      : [{ harness: "claude" }, { harness: "codex" }, { harness: "cursor" }];
    const rows = agentTrio(state.clis, seat);
    const limited = (state.usage && state.usage.seats || []).some((s) => s.status === "limited");
    const opts = seats.map((row) => {
      const id = row.harness === "codex" || row.harness === "cursor" ? row.harness : "claude";
      const shown = displayModel(row.model);
      const present = Boolean(rows.find((r) => r.seat === id)?.present);
      const on = (main.harness === "mock" ? "claude" : main.harness) === id && present;
      return `<button type="button" class="switch-opt${on ? " on" : ""}${present ? "" : " off"}" data-harness="${id}" data-seat="${id}" role="option">
        ${avatar(id)}<span class="switch-copy"><b>${escapeHtml((SEAT[id] || SEAT.claude).name)}</b><small>${escapeHtml(shown || "")}${present ? "" : " · não instalado"}</small></span>
      </button>`;
    }).join("");
    const shown = displayModel(main.model);
    const html = `<button type="button" class="switch-btn" id="switchBtn" aria-haspopup="listbox" aria-expanded="${state.switchOpen ? "true" : "false"}">
      ${avatar(seat)}<b>${escapeHtml((SEAT[seat] || SEAT.claude).name)}</b><span class="model">${escapeHtml(shown || "")}</span><i class="dot${limited ? " limited" : ""}"></i><span class="chev">▾</span>
    </button>
    <div class="switch-menu${state.switchOpen ? " open" : ""}" id="switchMenu" role="listbox">${opts}</div>`;
    const key = `${seat}|${main.model || ""}|${limited ? 1 : 0}|${opts}`;
    if (sw.dataset.chrome !== key) {
      sw.dataset.chrome = key;
      sw.innerHTML = html;
    }
  }
  renderJob();
  const views = $("viewBlock");
  if (views) views.hidden = !chrome.showViews;
  const limit = $("limitInd");
  if (limit) {
    const hit = (state.usage && state.usage.seats || []).find((s) => s.status === "limited");
    if (!hit) {
      limit.hidden = true;
      limit.textContent = "";
    } else {
      const when = hit.resetAt ? clockShort(hit.resetAt) : "";
      const name = hit.seat === "mock" ? "mock" : agentLabel(hit.seat === "claude" || hit.seat === "codex" || hit.seat === "cursor" ? hit.seat : "claude");
      const label = name.split(" · ")[0];
      const action = hit.policy === "snooze" ? "retomar" : "adiar";
      const next = state.usage && state.usage.next;
      const nextName = next && next !== "mock" ? agentLabel(next === "claude" || next === "codex" || next === "cursor" ? next : "claude").split(" · ")[0] : next === "mock" ? "mock" : "";
      const html = `${escapeHtml(label)} limitado${when ? ` · ${escapeHtml(when)}` : ""}${nextName ? ` · próximo ${escapeHtml(nextName)}` : ""} <button type="button" data-limit-seat="${escapeHtml(hit.seat)}" data-limit-policy="${hit.policy === "snooze" ? "resume" : "snooze"}">${action}</button>`;
      limit.hidden = !html.trim();
      limit.innerHTML = html;
    }
  }
  const stop = $("stopBtn");
  if (stop) stop.hidden = !(state.turn && state.turn.status === "running");
  if (input) {
    const ph = state.turn && state.turn.status === "running"
      ? "Entra na fila ao fim do turno…"
      : "Pergunta, URL de PR ou /help";
    if (input.placeholder !== ph) input.placeholder = ph;
  }
}

function renderImport() {
  const bar = $("ibar");
  if (!bar) return;
  if (chromeNow().showWelcome) {
    if (!bar.hidden || bar.innerHTML) {
      bar.hidden = true;
      bar.innerHTML = "";
    }
    return;
  }
  const srcs = Object.keys(state.importProgress || {});
  const src = srcs[0];
  const p = src && state.importProgress[src];
  if (p) {
    if (!bar.hidden || bar.innerHTML) {
      bar.hidden = true;
      bar.innerHTML = "";
    }
    renderJob();
    return;
  }
  const preview = state.import;
  const canApply = Boolean(preview && preview.sessions && preview.seenCount === 0);
  if (!preview || (!preview.newCount && !canApply)) {
    if (!bar.hidden || bar.innerHTML) {
      bar.hidden = true;
      bar.innerHTML = "";
    }
    return;
  }
  const neu = preview.newCount === 1 ? "1 nova" : preview.newCount > 1 ? `${preview.newCount} novas` : `${preview.sessions} ${preview.sessions === 1 ? "sessão" : "sessões"}`;
  const seen = preview.seenCount === 1 ? "1 já vista" : `${preview.seenCount} já vistas`;
  const detail = preview.newCount ? `${neu} · ${seen}` : neu;
  const action = canApply || preview.newCount
    ? `<button type="button" data-import-apply="${escapeHtml(preview.source)}">aplicar</button>`
    : "";
  bar.hidden = false;
  bar.innerHTML = `<div class="qitem" data-import="${escapeHtml(preview.source)}"><span>import</span><b>${escapeHtml(preview.source)} · ${detail}</b>${action}<button type="button" class="qx" data-import-dismiss="1" aria-label="fechar">×</button></div>`;
}

function renderQueue() {
  const bar = $("qbar");
  if (!bar) return;
  const main = (state.queue || []).filter((i) => i.session === "main");
  const nextIds = new Set(main.map((i) => i.id));
  const leaving = [...bar.querySelectorAll(".qitem")].filter((el) => !nextIds.has(el.dataset.qid));
  bar.hidden = main.length === 0 && leaving.length === 0;
  bar.innerHTML = main
    .map((i) => {
      const editing = state.editQid === i.id;
      const body = editing
        ? `<input class="qedit-input" data-qedit-input="${escapeHtml(i.id)}" value="${escapeHtml(i.text)}" />`
        : `<b>${escapeHtml(i.text)}</b>`;
      return `<div class="qitem" data-qid="${escapeHtml(i.id)}">${body}<span class="qacts"><button type="button" class="qnow" data-qnow="${escapeHtml(i.id)}">enviar agora</button><button type="button" class="qedit" data-qedit="${escapeHtml(i.id)}">editar</button><button type="button" class="qx" data-qid="${escapeHtml(i.id)}" aria-label="tirar">×</button></span></div>`;
    })
    .join("");
  const edit = bar.querySelector(".qedit-input");
  if (edit) {
    edit.focus();
    edit.select();
  }
  for (const el of leaving) {
    el.classList.add("out");
    bar.appendChild(el);
    bar.hidden = false;
    waitMotion(el).then(() => {
      el.remove();
      if (!bar.querySelector(".qitem")) bar.hidden = true;
    });
  }
}

function clockShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
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

function inboxStateOf(status) {
  if (status === "running") return "working";
  if (status === "needs_user") return "needs_you";
  if (status === "done") return "ready";
  return "settled";
}

function inboxLabelOf(state) {
  if (state === "working") return "trabalhando";
  if (state === "needs_you") return "precisa de você";
  if (state === "ready") return "pronto";
  return "fechado";
}

function inboxRowsOf(sparks) {
  return sparks
    .map((s) => ({ spark: s, state: inboxStateOf(s.status), label: inboxLabelOf(inboxStateOf(s.status)) }))
    .filter((r) => r.state !== "settled");
}

function nextNeedsYouOf(sparks, afterId) {
  const waiting = sparks.filter((s) => inboxStateOf(s.status) === "needs_you");
  if (!waiting.length) return undefined;
  if (!afterId) return waiting[0];
  const i = waiting.findIndex((s) => s.id === afterId);
  if (i < 0) return waiting[0];
  return waiting[(i + 1) % waiting.length];
}

function shouldNotifyOf(prev, next) {
  if (!document.hidden) return null;
  const permission = typeof Notification === "undefined" ? "denied" : Notification.permission;
  if (permission !== "granted") return null;
  const nextState = inboxStateOf(next.status);
  if (nextState !== "needs_you" && nextState !== "ready") return null;
  if (prev && inboxStateOf(prev.status) === nextState) return null;
  return {
    title: nextState === "needs_you" ? "spark precisa de você" : "spark pronto",
    body: `${next.view} #${next.seq} · ${next.title}`,
    tag: next.id,
  };
}

function maybeNotifySpark(prev, next) {
  if (typeof Notification === "undefined") return;
  const nextState = inboxStateOf(next.status);
  if (document.hidden && Notification.permission === "default" && (nextState === "needs_you" || nextState === "ready")) {
    void Notification.requestPermission();
    return;
  }
  const payload = shouldNotifyOf(prev, next);
  if (!payload) return;
  const note = new Notification(payload.title, { body: payload.body, tag: payload.tag });
  note.onclick = () => {
    window.focus();
    openSpark(next.id);
  };
}

function openNextNeedsYou() {
  const next = nextNeedsYouOf(state.sparks, state.openSpark || undefined);
  if (next) openSpark(next.id);
}

function renderShortcuts() {
  if (!chromeNow().showSparks) {
    shortcuts.innerHTML = "";
    return;
  }
  const rows = inboxRowsOf(state.sparks);
  const nextIds = new Set(rows.map((r) => r.spark.id));
  const leaving = [...shortcuts.querySelectorAll("[data-spark]")].filter((el) => !nextIds.has(el.dataset.spark));
  const glyph = { review: "⌥", refino: "✎", live: "▣" };
  const next = nextNeedsYouOf(state.sparks);
  const nextBtn = next
    ? `<button type="button" class="inbox-next" data-inbox="next" title="Alt+N">próximo</button>`
    : "";
  const head = rows.length || next ? `<div class="inbox-h">Sparks</div>` : "";
  shortcuts.innerHTML =
    head +
    nextBtn +
    rows
      .map((r) => {
        const f = r.spark;
        const fresh = !seenPills.has(f.id);
        const attn = r.state === "needs_you" || r.state === "ready";
        const klass = ["ch", fresh ? "pop" : "", attn ? "attn" : ""].filter(Boolean).join(" ");
        const n = f.needsUser?.count || (r.state === "ready" ? 1 : 0);
        const badge = n ? `<span class="badge">${n}</span>` : "";
        return `<button class="${klass}" data-spark="${f.id}">
        <div class="lbl"><b>${escapeHtml(f.view)} #${f.seq}</b>${escapeHtml(r.label)}</div>
        <div class="fa">${glyph[f.view] || "●"}${badge}</div>
      </button>`;
      })
      .join("");
  for (const el of leaving) {
    el.classList.add("out");
    el.classList.remove("pop");
    shortcuts.appendChild(el);
    waitMotion(el).then(() => el.remove());
  }
  for (const r of rows) seenPills.add(r.spark.id);
}

function renderContext() {
  const ctx = state.context;
  const head = $("ctxHead");
  const list = $("ctxList");
  const cascade = $("ctxCascade");
  const tree = $("ctxTree");
  const raw = debugView;
  if (head && ctx) {
    const model = ctx.compact?.model || "haiku";
    const spend = compactSpendLabelOf(ctx.compact?.tokensToday || 0, ctx.compact?.budget || 0);
    head.textContent = spend
      ? `${ctx.T} msgs · ${ctx.bytes}/${ctx.budget} · ${spend} · ${model}`
      : `${ctx.T} msgs · ${ctx.bytes}/${ctx.budget} · ${model}`;
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

function recallChipHtml(citations) {
  if (!citations || !citations.length) return "";
  const label = { verified: "verificado", superseded: "substituído", unverified: "sem zoom" };
  return `<div class="recall-chips">${citations.map((c) => {
    const st = c.status === "verified" || c.status === "superseded" ? c.status : "unverified";
    return `<button type="button" class="recall-chip ${st}" data-cite="${Number(c.id)}">#${Number(c.id)} ${label[st]}</button>`;
  }).join("")}</div>`;
}

function openRecallCite(id) {
  state.citeId = id;
  setDrawer(true);
  renderContext();
  requestAnimationFrame(() => {
    const row = [...document.querySelectorAll(".ctx-row")].find((el) => rowCoversCite(el, id));
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
  });
}

function rowCoversCite(el, id) {
  const start = Number(el.dataset.start);
  const n = Number(el.dataset.n) || 1;
  return id >= start && id < start + n;
}

function contextRowHtml(row) {
  const op = (state.ctxOps || []).find((o) => o.id === row.id || o.into === row.id);
  const enter = op && op.op === "add";
  const flash = op && (op.op === "update" || op.op === "merge");
  const cite = Number.isInteger(state.citeId) && state.citeId >= row.start && state.citeId < row.start + row.n;
  const klass = ["ctx-row", !row.built ? "pending" : "", enter ? "enter" : "", flash ? "flash" : "", cite ? "cite" : ""].filter(Boolean).join(" ");
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
  const wide = window.matchMedia("(min-width: 1100px)").matches;
  drawerGen += 1;
  const gen = drawerGen;
  if (open) {
    d.hidden = false;
    if (s && !wide) s.hidden = false;
    document.body.classList.add("drawer-open");
    requestAnimationFrame(() => {
      d.classList.add("in");
      if (s && !wide) s.classList.add("in");
    });
    return;
  }
  d.classList.remove("in");
  if (s) s.classList.remove("in");
  document.body.classList.remove("drawer-open");
  waitMotion(d).then(() => {
    if (gen !== drawerGen) return;
    d.hidden = true;
    if (s) s.hidden = true;
  });
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
      <rect x="${n.x}" y="${n.y}" width="${w - n.x - 12}" height="28" rx="16" fill="${UI_T.card}" stroke="${UI_T.line}"/>
      <rect x="${n.x}" y="${n.y}" width="36" height="28" rx="6" fill="${badgeTone(n.row.n)}"/>
      <text x="${n.x + 18}" y="${n.y + 18}" text-anchor="middle" fill="#fff" font-size="10" font-family="ui-monospace,monospace">x${n.row.n}</text>
      <text x="${n.x + 44}" y="${n.y + 18}" fill="#d0d0d0" font-size="10" font-family="ui-monospace,monospace">${label}</text>
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" height="${h}">${lines.join("")}${boxes}</svg>`;
}

function badgeTone(n) {
  const stops = [[0, [43, 43, 49]], [2, [54, 54, 61]], [4, [74, 74, 83]], [6, [107, 107, 117]], [8, [142, 142, 153]]];
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

async function openSpark(id) {
  overlayGen += 1;
  const gen = overlayGen;
  setDrawer(false);
  setSwitchOpen(false);
  overlay.hidden = false;
  if (!modal.querySelector(".mh")) modal.innerHTML = `<div class="mh"><b>…</b></div>`;
  requestAnimationFrame(() => {
    if (gen === overlayGen) overlay.classList.add("in");
  });
  const keepTab = state.openSpark === id && overlay.classList.contains("in");
  const res = await fetch(`/api/sparks/${encodeURIComponent(id)}`);
  if (!res.ok || gen !== overlayGen) return;
  state.sparkDetail = await res.json();
  state.openSpark = id;
  const f = state.sparkDetail.spark || state.sparkDetail.fork;
  if (f.status === "merged") {
    hideOverlay();
    return;
  }
  if (!keepTab) {
    const qTab = new URLSearchParams(location.search).get("tab");
    if (qTab === "Overview" || qTab === "Guide" || qTab === "Diff") state.sparkTab = qTab;
    else state.sparkTab = (f.ui && f.ui.tab) || (state.views.find((v) => v.id === f.view)?.tabs?.[0]) || "Guide";
  }
  if (gen !== overlayGen) return;
  document.body.classList.toggle("rv-open", f.view === "review");
  drawModal();
  overlay.classList.add("in");
}

async function postAct(action) {
  if (!state.openSpark) return;
  const id = state.openSpark;
  const res = await fetch(`/api/sparks/${encodeURIComponent(id)}/act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!res.ok) return;
  const data = await res.json();
  if ((data.spark || data.fork)?.status === "merged") {
    hideOverlay();
    return;
  }
  await openSpark(id);
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

function paintReviewedButton(btn) {
  const on = !btn.classList.contains("on");
  btn.classList.toggle("on", on);
  const box = btn.querySelector(".box");
  if (box) box.textContent = on ? "✓" : "";
}

function flipReviewedLocal(kind, id) {
  const spark = state.sparkDetail && (state.sparkDetail.spark || state.sparkDetail.fork);
  const ui = spark && spark.ui;
  if (!ui) return;
  if (kind === "chapter") {
    const ch = (ui.chapters || []).find((c) => c.id === id);
    if (ch) ch.reviewed = !ch.reviewed;
    return;
  }
  const file = (ui.fileState || []).find((s) => s.path === id);
  if (file) file.reviewed = !file.reviewed;
}

function hideOverlay() {
  overlayGen += 1;
  const gen = overlayGen;
  overlay.classList.remove("in");
  document.body.classList.remove("rv-open");
  state.openSpark = null;
  waitMotion(overlay).then(() => {
    if (gen !== overlayGen) return;
    overlay.hidden = true;
    overlay.classList.remove("rv");
    modal.classList.remove("rv");
  });
}

function jumpReview(el) {
  const tab = el.dataset.rvTab || "Guide";
  const goto = el.dataset.rvGoto;
  const path = el.dataset.rvFile;
  const line = el.dataset.rvLine;
  if (tab !== state.sparkTab) {
    state.sparkTab = tab;
    bindGuidedReview(modal);
  }
  requestAnimationFrame(() => {
    if (goto) document.getElementById(goto)?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (path) {
      const card = document.getElementById(`file-${cssId(path)}`);
      card?.scrollIntoView({ block: "start", behavior: "smooth" });
      modal.querySelectorAll("[data-rv-file]").forEach((n) => {
        n.classList.toggle("on", n.dataset.rvFile === path);
      });
      if (line) {
        modal.querySelectorAll("tr.on").forEach((n) => n.classList.remove("on"));
        const tr = modal.querySelector(`table.rv-diff[data-file="${path}"] tr[data-new="${line}"]`);
        tr?.classList.add("on");
        tr?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  });
}

function bindGuidedReview(root) {
  const tab = state.sparkTab || "Guide";
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
  const detail = state.sparkDetail;
  if (!detail) return;
  const view = (detail.spark || detail.fork)?.view;
  overlay.classList.toggle("rv", view === "review");
  modal.classList.toggle("rv", view === "review");
  if (detail.html) {
    modal.innerHTML = detail.html;
    if (view === "review") bindGuidedReview(modal);
    bindShip(modal);
    bindLiveGuards(modal);
    bindLiveUrlAsks(modal);
    bind3dPause();
    return;
  }
  const f = detail.spark || detail.fork;
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
  if (state.sparkTab === "Overview") {
    body = `<div>${escapeHtml(ui.overview || f.title)}</div>`;
  } else if (state.sparkTab === "Diff") {
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
      .map((t) => `<button data-tab="${t}" class="${t === state.sparkTab ? "on" : ""}">${t}</button>`)
      .join("")}</div>
    <div class="mbody">${body}</div>
    <form class="mi" id="sparkForm">
      <input name="t" placeholder="Fala com esse spark… (volta pro chat sozinho quando terminar)" autocomplete="off" />
    </form>`;
  bindShip(modal);
}

const shipping = new Set();

function bindShip(root) {
  const ship = state.sparkDetail && state.sparkDetail.ship;
  const spark = state.sparkDetail && (state.sparkDetail.spark || state.sparkDetail.fork);
  if (!ship || ship.kind === "idle" || !spark) return;
  const mh = (root || modal).querySelector(".mh");
  if (!mh || mh.querySelector(".ship-go")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ship-go";
  btn.textContent = ship.label;
  if (shipping.has(spark.id)) {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
  }
  btn.addEventListener("click", () => {
    if (btn.disabled || shipping.has(spark.id)) return;
    shipSpark(spark.id, btn);
  });
  const close = mh.querySelector(".x");
  mh.insertBefore(btn, close);
}

async function shipSpark(id, btn) {
  if (shipping.has(id)) return;
  shipping.add(id);
  if (btn) {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
  }
  try {
    const res = await fetch(`/api/sparks/${encodeURIComponent(id)}/ship`, { method: "POST" });
    if (!res.ok) return;
    await openSpark(id);
  } finally {
    shipping.delete(id);
    if (btn) {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
  }
}

function applyEvent(ev) {
  switch (ev.type) {
    case "message":
      if (ev.session === "main") {
        state.stream = "";
        const pendingAt = state.messages.findIndex((m) => m.i < 0 && m.kind === "user" && m.text === ev.message.text);
        if (pendingAt >= 0) state.messages.splice(pendingAt, 1, ev.message);
        else state.messages.push(ev.message);
        if (ev.message && ev.message.i >= 0) {
          state.messageCount = Math.max(state.messageCount || 0, ev.message.i + 1);
        }
        trimFollowWindow();
        scheduleFullPaint();
      } else if (state.openSpark === ev.session && state.sparkDetail) {
        state.sparkDetail.messages = state.sparkDetail.messages || [];
        state.sparkDetail.messages.push(ev.message);
        drawModal();
      }
      break;
    case "delta":
      if (ev.session === "main" && ev.text) {
        state.stream = (state.stream || "") + ev.text;
        state.streamSeat = ev.seat || state.streamSeat;
        state.streamModel = ev.model || state.streamModel;
        if (state.turn && ev.stepId) {
          const steps = state.turn.steps || (state.turn.steps = []);
          const step = steps.find((s) => s.id === ev.stepId);
          if (step) {
            const cur = step.text || "";
            if (cur !== ev.text) step.text = cur + ev.text;
          }
        }
        scheduleLivePaint();
      }
      break;
    case "queue":
      state.queue = ev.items || [];
      renderQueue();
      break;
    case "usage":
      state.usage = ev.usage || { seats: [], chain: [] };
      renderChrome();
      break;
    case "import-progress":
      if (ev.source) {
        state.importProgress = { ...(state.importProgress || {}), [ev.source]: { done: ev.done || 0, total: ev.total || 0, error: ev.error || "" } };
        markJobStart(`import:${ev.source}`);
        const btn = log.querySelector(`[data-welcome-import="${ev.source}"]`);
        if (btn) paintImportChip(btn, ev.source);
        else if (chromeNow().showWelcome) renderChat();
        renderJob();
      }
      break;
    case "import":
      state.import = ev.preview || null;
      if (ev.offers) state.importOffers = ev.offers;
      if (Array.isArray(ev.messages)) {
        applyMessagePage(ev);
        scheduleFullPaint();
      }
      if (ev.preview && ev.preview.source && state.importProgress && state.importProgress[ev.preview.source]) {
        const prev = state.importProgress[ev.preview.source];
        const total = prev.total || 1;
        state.importProgress[ev.preview.source] = { done: total, total };
        const src = ev.preview.source;
        state.jobFade = "import";
        renderJob();
        setTimeout(() => {
          if (state.importProgress) delete state.importProgress[src];
          clearJobStart(`import:${src}`);
          if (state.jobFade === "import") state.jobFade = null;
          renderImport();
          renderJob();
          if (chromeNow().showWelcome) renderChat();
          else {
            const btn = log.querySelector(`[data-welcome-import="${src}"]`);
            if (btn) paintImportChip(btn, src);
          }
        }, 1400);
      }
      renderImport();
      if (chromeNow().showWelcome) renderChat();
      break;
    case "turn":
      if (ev.session === "main") {
        state.turn = ev.turn;
        renderQueue();
        renderChrome();
        if (ev.turn && ev.turn.status !== "running") {
          state.stream = "";
          dropStreamNode();
          if (ev.turn.status === "done" || ev.turn.status === "error" || ev.turn.status === "stopped") {
            state.lastTurn = ev.turn;
          }
          scheduleFullPaint();
        } else {
          scheduleLivePaint();
        }
      } else {
        state.sparkTurns[ev.session] = ev.turn;
        if (state.openSpark === ev.session) drawModal();
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
      if (ev.main && state.seats) {
        state.seats = state.seats.map((s) => (
          s.harness === ev.main.harness ? { harness: s.harness, model: ev.main.model } : s
        ));
      }
      renderChrome();
      break;
    case "compact":
      state.compact = ev.compact;
      if (ev.compact && ev.compact.running) {
        markJobStart("compact");
        state.jobFade = null;
      } else if (ev.compact && !ev.compact.error && !ev.compact.paused && (ev.compact.done > 0 || ev.compact.total > 0)) {
        state.jobFade = "compact";
        renderJob();
        setTimeout(() => {
          if (state.jobFade === "compact") state.jobFade = null;
          clearJobStart("compact");
          renderJob();
        }, 1400);
      }
      renderChrome();
      break;
    case "spark": {
      const spark = ev.spark || ev.fork;
      const i = state.sparks.findIndex((f) => f.id === spark.id);
      const prev = i >= 0 ? state.sparks[i] : undefined;
      if (i >= 0) state.sparks[i] = spark;
      else state.sparks.push(spark);
      maybeNotifySpark(prev, spark);
      openPendingReview(spark);
      renderShortcuts();
      if (state.openSpark === spark.id) {
        if (spark.status === "merged") {
          hideOverlay();
          break;
        }
        if (state.sparkDetail) {
          state.sparkDetail.spark = spark;
          if (!state.sparkDetail.html) drawModal();
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
    setSwitchOpen(!state.switchOpen);
    return;
  }
  const limitBtn = e.target.closest("[data-limit-seat]");
  if (limitBtn) {
    e.preventDefault();
    fetch("/api/usage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seat: limitBtn.dataset.limitSeat, policy: limitBtn.dataset.limitPolicy }),
    });
    return;
  }
  const opt = e.target.closest("[data-harness]");
  if (opt) {
    e.preventDefault();
    setSwitchOpen(false);
    fetch("/api/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: opt.dataset.harness }),
    });
    return;
  }
  if (state.switchOpen && !e.target.closest(".agent-switch")) {
    setSwitchOpen(false);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.switchOpen) {
    setSwitchOpen(false);
    return;
  }
  if (overlay.classList.contains("in")) {
    hideOverlay();
    return;
  }
  if (document.body.classList.contains("drawer-open")) setDrawer(false);
});

setInterval(() => {
  if (state.turn && state.turn.status === "running") paintTick();
}, 100);

document.addEventListener("click", (e) => {
  const sum = e.target.closest(".work-sum");
  if (sum) {
    e.preventDefault();
    const disc = sum.closest(".work-disc");
    const id = disc?.dataset?.turn;
    if (id) {
      if (state.workOpen.has(id)) state.workOpen.delete(id);
      else state.workOpen.add(id);
      disc.classList.toggle("open", state.workOpen.has(id));
    }
    if (id && state.workOpen.has(id)) {
      stick.follow = true;
      followScroll();
    }
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
  const chip = e.target.closest(".recall-chip");
  if (chip) {
    e.preventDefault();
    openRecallCite(Number(chip.dataset.cite));
    return;
  }
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
  const existing = state.sparks.find((f) => f.view === id && f.status !== "merged");
  if (existing) {
    openSpark(existing.id);
    return;
  }
  fetch("/api/sparks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ view: id, params }),
  });
});

shortcuts.addEventListener("click", (e) => {
  if (e.target.closest("[data-inbox='next']")) {
    openNextNeedsYou();
    return;
  }
  const b = e.target.closest("[data-spark]");
  if (b) openSpark(b.dataset.spark);
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
    state.sparkTab = tab;
    drawModal();
    return;
  }
  const actEarly = e.target.closest?.("[data-act]");
  if (actEarly && state.openSpark) {
    const act = actEarly.dataset.act;
    if (act === "comment-add") {
      const body = window.prompt("Comentário nesta linha");
      if (body && body.trim()) postAct({ type: "comment-add", id: actEarly.dataset.id, value: body.trim() });
      return;
    }
    if (act === "review-file" || act === "review-chapter") {
      paintReviewedButton(actEarly);
      flipReviewedLocal(act === "review-chapter" ? "chapter" : "file", actEarly.dataset.id);
      const sparkId = state.openSpark;
      void fetch(`/api/sparks/${encodeURIComponent(sparkId)}/act`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: act, id: actEarly.dataset.id }),
      }).then((r) => r.ok ? r.json() : null).then((data) => {
        if ((data?.spark || data?.fork)?.status === "merged") hideOverlay();
      });
      return;
    }
    if (act === "other") {
      const id = actEarly.dataset.id;
      const input = document.createElement("input");
      input.className = "other";
      input.placeholder = "outra…";
      actEarly.replaceWith(input);
      input.focus();
      input.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        const value = input.value.trim();
        if (!value) return;
        postAct({ type: "answer", id, value });
      });
      return;
    }
    postAct({ type: act, id: actEarly.dataset.id, value: actEarly.dataset.value });
    return;
  }
  const jumpEl = e.target.closest?.("[data-rv-file], [data-rv-goto], [data-rv-tab]");
  if (jumpEl && jumpEl.closest(".rv-body")) {
    jumpReview(jumpEl);
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
});

async function sendUser(text, mode) {
  const t = String(text || "").trim();
  if (!t) return;
  const running = state.turn && state.turn.status === "running";
  const slash = t === "/help" || t === "/?" || t.startsWith("/ncli");
  const pasteReview = isLonePrUrl(t);
  const body = { text: t };
  if (running) {
    body.mode = mode || "queue";
    if (body.mode === "queue") {
      state.queue = [...(state.queue || []), {
        id: "local-" + Date.now().toString(36),
        session: "main",
        text: t,
        mode: "queue",
        createdAt: new Date().toISOString(),
      }];
      renderQueue();
    }
  }
  if (!running && !slash && !pasteReview) {
    const atFloor = !chat || chat.scrollHeight - chat.scrollTop - chat.clientHeight <= STICK_SLOP;
    const pending = {
      kind: "user",
      text: t,
      date: new Date().toISOString(),
      i: -Date.now(),
    };
    state.messages.push(pending);
    state.messageCount = (state.messageCount || 0) + 1;
    state.turn = {
      id: "local-" + Date.now().toString(36),
      session: "main",
      seat: state.main.harness || "claude",
      model: state.main.model,
      status: "running",
      startedAt: pending.date,
      lastEventAt: pending.date,
      steps: [],
    };
    const keepTop = chat ? chat.scrollTop : 0;
    if (atFloor) stick.follow = true;
    else stick.follow = false;
    syncChat();
    if (!atFloor) setChatTop(keepTop);
    paintTick();
  }
  const res = await fetch("/api/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (data.queue) {
    state.queue = data.queue;
    renderQueue();
  }
  if (pendingReviewOpen) {
    const spark = state.sparks.find((s) => s.view === "review" && sameReviewParams(s.params, pendingReviewOpen));
    if (spark) openPendingReview(spark);
  }
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  const hint = reviewPasteHint(text);
  input.value = "";
  renderPasteHint();
  if (hint) {
    pendingReviewOpen = hint;
    const bar = $("phint");
    if (bar) {
      bar.hidden = false;
      bar.innerHTML = `<div class="qitem" data-pr-hint="${escapeHtml(hint.pr)}"><span>review</span><b>abrindo #${escapeHtml(hint.pr)}</b></div>`;
      measureComposer();
    }
  }
  void sendUser(text, e.shiftKey ? "queue" : undefined);
});

input?.addEventListener("input", renderPasteHint);
input?.addEventListener("paste", () => requestAnimationFrame(renderPasteHint));

log?.addEventListener("click", async (e) => {
  const go = e.target.closest("[data-welcome-import]");
  if (!go) return;
  const src = go.getAttribute("data-welcome-import");
  state.importProgress = { ...(state.importProgress || {}), [src]: { done: 0, total: 0 } };
  markJobStart(`import:${src}`);
  paintImportChip(go, src);
  renderImport();
  renderJob();
  void fetch("/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: go.getAttribute("data-welcome-import"), apply: true }),
  });
});

$("jobInd")?.addEventListener("click", (e) => {
  const retry = e.target.closest("[data-job-retry]");
  if (!retry) return;
  const kind = retry.getAttribute("data-job-retry");
  const src = retry.getAttribute("data-job-source");
  if (kind === "import" && src) {
    if (state.importProgress && state.importProgress[src]) {
      state.importProgress[src] = { ...state.importProgress[src], error: "" };
    }
    renderJob();
    void fetch("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: src, apply: true }),
    });
    return;
  }
  if (kind === "compact") {
    if (state.compact) state.compact = { ...state.compact, error: "", running: true };
    renderJob();
    void fetch("/api/compact", { method: "POST" });
  }
});

$("ibar")?.addEventListener("click", async (e) => {
  if (e.target.closest("[data-import-dismiss]")) {
    state.import = null;
    renderImport();
    return;
  }
  const apply = e.target.closest("[data-import-apply]");
  if (!apply) return;
  const src = apply.dataset.importApply;
  state.importProgress = { ...(state.importProgress || {}), [src]: { done: 0, total: 0 } };
  markJobStart(`import:${src}`);
  renderImport();
  renderJob();
  void fetch("/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: src, apply: true }),
  });
});

async function saveQueueEdit(id, text) {
  state.editQid = "";
  const res = await fetch(`/api/queue/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.queue) state.queue = data.queue;
  renderQueue();
}

$("qbar")?.addEventListener("click", async (e) => {
  const now = e.target.closest("[data-qnow]");
  if (now) {
    const res = await fetch(`/api/queue/${encodeURIComponent(now.dataset.qnow)}/now`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (data.queue) state.queue = data.queue;
    renderQueue();
    return;
  }
  const edit = e.target.closest("[data-qedit]");
  if (edit) {
    state.editQid = edit.dataset.qedit;
    renderQueue();
    return;
  }
  const btn = e.target.closest(".qx[data-qid]");
  if (!btn) return;
  const res = await fetch(`/api/queue/${encodeURIComponent(btn.dataset.qid)}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (data.queue) state.queue = data.queue;
  renderQueue();
});

$("qbar")?.addEventListener("keydown", (e) => {
  const inp = e.target.closest("[data-qedit-input]");
  if (!inp) return;
  if (e.key === "Enter") {
    e.preventDefault();
    void saveQueueEdit(inp.dataset.qeditInput, inp.value);
  }
  if (e.key === "Escape") {
    state.editQid = "";
    renderQueue();
  }
});

$("qbar")?.addEventListener("focusout", (e) => {
  const inp = e.target.closest("[data-qedit-input]");
  if (!inp || e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
  void saveQueueEdit(inp.dataset.qeditInput, inp.value);
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
  if (e.altKey && (e.key === "n" || e.key === "N") && !e.repeat) {
    e.preventDefault();
    openNextNeedsYou();
  }
});

$("uiCollapse")?.addEventListener("click", () => collapseUi());

overlay.addEventListener("submit", async (e) => {
  if (e.target.id !== "sparkForm" && e.target.id !== "forkForm") return;
  e.preventDefault();
  const t = e.target.t.value.trim();
  if (!t || !state.openSpark) return;
  e.target.t.value = "";
  const view = (state.sparkDetail?.spark || state.sparkDetail?.fork)?.view;
  if (view === "refino") {
    await postAct({ type: "say", value: t });
    return;
  }
  await fetch(`/api/sparks/${encodeURIComponent(state.openSpark)}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: t }),
  });
  if (state.openSpark) await openSpark(state.openSpark);
});

$("menuBtn").addEventListener("click", () => {
  setDrawer(!document.body.classList.contains("drawer-open"));
});
$("scrim").addEventListener("click", () => setDrawer(false));

chat.addEventListener("wheel", (e) => {
  if (e.deltaY < 0) markUserUp();
}, { passive: true });
chat.addEventListener("touchstart", (e) => {
  touchY = e.touches[0]?.clientY || 0;
}, { passive: true });
chat.addEventListener("touchmove", (e) => {
  const y = e.touches[0]?.clientY || 0;
  if (y > touchY + 2) markUserUp();
  touchY = y;
}, { passive: true });
document.addEventListener("keydown", (e) => {
  if (e.target === input) return;
  if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") markUserUp();
});
chat.addEventListener("scroll", () => {
  const top = chat.scrollTop;
  const leftover = chat.scrollHeight - top - chat.clientHeight;
  if (programmaticScroll) {
    lastScrollTop = top;
    paintScrollHints();
    return;
  }
  if (userUp || top < lastScrollTop) {
    stick.follow = false;
    userUp = false;
  } else if (leftover <= STICK_SLOP) {
    stick.follow = true;
  }
  lastScrollTop = top;
  if (top < 120) void loadOlder();
  paintScrollHints();
}, { passive: true });
bindChatFloor();
bindComposerModality();
$("jumpLatest")?.addEventListener("click", jumpToLatest);

function bindComposerModality() {
  const form = $("form");
  if (!form) return;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab") form.classList.add("from-key");
  });
  document.addEventListener("pointerdown", () => {
    form.classList.remove("from-key");
  });
}
window.addEventListener("resize", () => {
  measureComposer();
  if (stick.follow) followScroll();
  paintScrollHints();
});

async function boot() {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    try {
      applyEvent(JSON.parse(m.data));
    } catch {
      return;
    }
  };
  const snap = await (await fetch("/api/state")).json();
  if (!state.messages.length) applyMessagePage(snap);
  if (!state.sparks.length) state.sparks = snap.sparks || [];
  for (const f of state.sparks) seenPills.add(f.id);
  if (!state.views.length) state.views = snap.views || [];
  state.debug = state.debug || snap.debug;
  state.context = state.context || snap.context || null;
  if (!state.ctxPrev.length) state.ctxPrev = (snap.context && snap.context.rows) || [];
  state.main = snap.main || state.main;
  if (snap.seats) state.seats = snap.seats;
  if (!state.lastTurn) state.lastTurn = snap.turn && snap.turn.status !== "running" ? snap.turn : null;
  if (!state.turn) state.turn = snap.turn || null;
  if (!state.compact) state.compact = snap.compact || null;
  if (!state.queue.length) state.queue = snap.queue || [];
  if (snap.usage) state.usage = snap.usage;
  if (snap.import) state.import = snap.import;
  if (snap.importOffers) state.importOffers = snap.importOffers;
  if (snap.clis) state.clis = snap.clis;
  renderImport();
  renderQueue();
  renderChat();
  renderShortcuts();
  renderContext();
  if (stick.follow) {
    snapToFloor();
    requestAnimationFrame(() => {
      if (stick.follow) snapToFloor();
    });
  }
  const q = new URLSearchParams(location.search);
  const open = q.get("open");
  const tab = q.get("tab");
  if (tab === "Overview" || tab === "Guide" || tab === "Diff") state.sparkTab = tab;
  if (open) await openSpark(open);
  const ch = q.get("chapter");
  if (ch) document.getElementById(ch)?.scrollIntoView({ block: "start" });
}

renderChat();
renderChrome();
watchComposer();
boot();
