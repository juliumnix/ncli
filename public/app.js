const $ = (id) => document.getElementById(id);
const chat = $("chat");
const shortcuts = $("shortcuts");
const overlay = $("overlay");
const modal = $("modal");
const input = $("input");
const debugView = $("debugView");
const debugMeta = $("debugMeta");
const viewList = $("viewList");

const stick = { follow: true };
const STICK_SLOP = 64;

const state = {
  messages: [],
  forks: [],
  views: [],
  waiting: [],
  debug: null,
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
  const re = /```ncli[ \t]+(mermaid|html|react|url)[ \t]*\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push(md(text.slice(last, m.index), false));
    segs.push(iframeFor(m[1], m[2].trim()));
    last = m.index + m[0].length;
  }
  const rest = text.slice(last);
  const open = rest.match(/```ncli[ \t]+(mermaid|html|react|url)[ \t]*\n([\s\S]*)$/);
  if (open && !open[2].includes("```")) segs.push(shimmerFor(open[1], open[2]));
  else if (rest) segs.push(md(rest, streaming));
  return segs.join("") || md(text, streaming);
}

function md(text, streaming) {
  if (typeof renderMarkdown === "function") return renderMarkdown(text, !!streaming);
  return rich(text);
}

function shimmerFor(kind, source) {
  const shape = kind === "mermaid" ? "diagram" : kind === "url" ? "page" : kind === "react" ? "card" : /chart|canvas|svg|bar|plot/i.test(source || "") ? "chart" : "card";
  const label = shape === "diagram" ? "desenhando diagrama…" : shape === "chart" ? "desenhando gráfico…" : kind === "react" ? "montando componente…" : shape === "page" ? "carregando página…" : "montando prévia…";
  const body = shape === "diagram" ? "<i></i><i></i><i></i>" : shape === "chart" ? "<b></b><b></b><b></b><b></b>" : shape === "page" ? "<s></s><em></em><em></em><em></em>" : "<s></s><em></em><em></em>";
  return `<div class="live-ph" data-kind="${kind}" data-shape="${shape}" aria-busy="true"><div class="live-ph-label">${label}</div><div class="live-ph-body ${shape}">${body}</div></div>`;
}

function liveError(kind, source, error) {
  return `<div class="live-err" data-kind="${kind}"><div class="live-err-h">não deu para renderizar ${escapeHtml(kind)}</div><div class="live-err-m">${escapeHtml(error)}</div><pre class="live-err-src">${escapeHtml(source)}</pre></div>`;
}

function iframeFor(kind, source) {
  try {
    if (kind === "url") {
      let href = "";
      try {
        const u = new URL(source.trim());
        if (u.protocol === "http:" || u.protocol === "https:") href = u.toString();
      } catch { /* blocked */ }
      if (!href) return liveError(kind, source, "url bloqueada");
      return `<div class="live-wrap in"><iframe class="live-frame" title="live url" sandbox="allow-scripts allow-popups" src="${escapeHtml(href)}"></iframe></div>`;
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
    const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';"></head><body>${inner}</body></html>`
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;");
    return `<div class="live-wrap in"><iframe class="live-frame" title="live ${kind}" sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe></div>`;
  } catch (err) {
    return liveError(kind, source, err instanceof Error ? err.message : String(err));
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
    return `<rect x="${x}" y="28" width="100" height="40" rx="8" fill="#e8f1ff" stroke="#93c5fd"/><text x="${x + 50}" y="53" text-anchor="middle" font-size="11" font-family="sans-serif">${label}</text>`;
  }).join("");
  const arrows = edges.map(([a, b]) => {
    const x1 = 20 + ids.indexOf(a) * 120 + 100;
    const x2 = 20 + ids.indexOf(b) * 120;
    return `<line x1="${x1}" y1="48" x2="${x2}" y2="48" stroke="#2563eb" marker-end="url(#ncli-arrow)"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 96" width="100%" height="96"><defs><marker id="ncli-arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#2563eb"/></marker></defs>${arrows}${boxes}</svg>`;
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
  for (const m of state.messages) {
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
  chat.innerHTML = parts.join("");
  measureComposer();
  if (stick.follow) chat.scrollTop = chat.scrollHeight;
  else chat.scrollTop = keep;
  renderChrome();
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
  const seat = turn.seat || "claude";
  const elapsed = elapsedLabel(turn.startedAt);
  const silent = Date.now() - Date.parse(turn.lastEventAt || turn.startedAt) >= 5000;
  const status = silent
    ? `ainda trabalhando · ${elapsed}`
    : `pensando… · ${elapsed}`;
  const steps = (turn.steps || []).map((s) => stepHtml(s)).join("");
  return `<div class="live" data-turn="${escapeHtml(turn.id)}">
    <div class="live-h">${avatar(seat)}<div>
      <div class="nm ${seat === "claude" ? "ncl" : seat === "codex" ? "ncx" : "ncu"}">${escapeHtml(agentLabel(seat, turn.model))}</div>
      <div class="live-st"><span class="spin"></span>${escapeHtml(status)}</div>
    </div></div>
    <div class="live-steps">${steps}</div>
  </div>`;
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
    sw.innerHTML = `${avatar(seat)}<label><span>${escapeHtml(agentLabel(seat, main.model))}</span>
      <select id="harnessSel" aria-label="agente principal">
        <option value="claude"${main.harness === "claude" ? " selected" : ""}>Claude</option>
        <option value="codex"${main.harness === "codex" ? " selected" : ""}>Codex</option>
        <option value="cursor"${main.harness === "cursor" ? " selected" : ""}>Cursor</option>
      </select></label>`;
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

function renderDebug() {
  const d = state.debug;
  if (!d) return;
  debugMeta.textContent = `${d.bytes}/${d.budget} bytes · ${d.T ?? "?"} msgs · ${(d.levels || []).join(" ")}`;
  debugView.textContent = (d.lines || []).join("\n");
  viewList.innerHTML = state.views
    .map((v) => `<li><code>view://${v.id}</code> · ${escapeHtml(v.label)} <span class="muted">${escapeHtml(v.file)}</span></li>`)
    .join("");
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
        renderChat();
      }
      break;
    case "turn":
      if (ev.session === "main") {
        state.turn = ev.turn;
        if (ev.turn && ev.turn.status !== "running") state.stream = "";
        renderChat();
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
        renderChat();
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
      renderDebug();
      break;
    case "debug":
      state.debug = ev;
      renderDebug();
      break;
    default:
      break;
  }
}

$("stopBtn")?.addEventListener("click", () => {
  fetch("/api/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: "main" }) });
});

document.addEventListener("change", (e) => {
  if (e.target.id !== "harnessSel") return;
  fetch("/api/harness", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: e.target.value }),
  });
});

setInterval(() => {
  if (state.turn && state.turn.status === "running") renderChat();
}, 1000);

chat.addEventListener("click", (e) => {
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

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  await fetch("/api/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
});

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
  const d = $("drawer");
  const s = $("scrim");
  d.hidden = !d.hidden;
  s.hidden = d.hidden;
});
$("scrim").addEventListener("click", () => {
  $("drawer").hidden = true;
  $("scrim").hidden = true;
});

chat.addEventListener("scroll", () => {
  stick.follow = chat.scrollHeight - chat.scrollTop - chat.clientHeight <= STICK_SLOP;
}, { passive: true });
window.addEventListener("resize", () => {
  measureComposer();
  if (stick.follow) chat.scrollTop = chat.scrollHeight;
});

async function boot() {
  const snap = await (await fetch("/api/state")).json();
  state.messages = snap.messages || [];
  state.forks = snap.forks || [];
  for (const f of state.forks) seenPills.add(f.id);
  state.views = snap.views || [];
  state.debug = snap.debug;
  state.main = snap.main || state.main;
  state.turn = snap.turn || null;
  state.compact = snap.compact || null;
  renderChat();
  renderShortcuts();
  renderDebug();
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
