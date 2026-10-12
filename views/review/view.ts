import type { Spark } from "../../src/types";
import type { ViewAction, ViewActionResult, ViewPlugin } from "../../src/views/types";
import type { SparkResult } from "../../src/views/manifest";
import type { PrInfo } from "../../src/gh/pr";
import {
  buildReviewUi,
  extractPlan,
  splitPath,
  toggleReviewed,
  type DiffLine,
  type FindingStatus,
  type ReviewChapter,
  type ReviewFinding,
  type ReviewUi,
} from "../../src/review/model";
import {
  addComment,
  applyRereview,
  commentId,
  findingsFence,
  mergeFindings,
  sendComments,
  setFindingStatus,
} from "../../src/review/loop";
import { escapeHtml } from "../../src/util";

function uiOf(spark: Spark): ReviewUi {
  return spark.ui as ReviewUi;
}

function fileIcon(path: string): string {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const map: Record<string, string> = {
    ts: "TS",
    tsx: "TS",
    js: "JS",
    json: "{}",
    md: "MD",
    swift: "SW",
  };
  const label = map[ext] ?? (ext.slice(0, 2) || "·").toUpperCase();
  return `<span class="rv-ico">${escapeHtml(label)}</span>`;
}

function plusMinus(add: number, del: number): string {
  const a = add ? `<span class="rv-a">+${add}</span>` : "";
  const d = del ? `<span class="rv-d">−${del}</span>` : "";
  return `${a}${d || (add ? "" : `<span class="rv-z">0</span>`)}`;
}

function fileRow(file: { path: string; additions: number; deletions: number }, opts?: { active?: boolean; click?: boolean }): string {
  const { name, dir } = splitPath(file.path);
  const active = opts?.active ? " on" : "";
  const click = opts?.click ? ` data-rv-file="${escapeHtml(file.path)}"` : "";
  return `<button type="button" class="rv-file${active}"${click} data-path="${escapeHtml(file.path)}">
    ${fileIcon(file.path)}
    <span class="rv-fn"><b>${escapeHtml(name)}</b><i>${escapeHtml(dir)}</i></span>
    <span class="rv-pm">${plusMinus(file.additions, file.deletions)}</span>
  </button>`;
}

function overview(ui: ReviewUi): string {
  const files = ui.pr.files.map((f) => fileRow(f, { click: true })).join("");
  const ready = ui.planSource === "agent";
  const summary = ready
    ? `<p>${escapeHtml(ui.summary)}</p>`
    : shimmer(3);
  const findings = ready ? findingsPanel(ui) : shimmer(3);
  const order = ui.chapters.map((ch) => orderRow(ch)).join("");
  return `<div class="rv-overview" data-rv-panel="Overview">
    <header class="rv-ov-lead">
      <h1>${escapeHtml(ui.pr.title)}</h1>
      <div class="rv-meta">
        <span>${escapeHtml(ui.pr.author)}</span>
        <span class="dot"></span>
        <span>#${ui.pr.number}</span>
        <span class="dot"></span>
        <span class="rv-a">+${ui.pr.additions}</span>
        <span class="rv-d">−${ui.pr.deletions}</span>
      </div>
    </header>
    <div class="rv-ov-main">
      <section class="rv-ov-summary">
        <div class="rv-ov-k">Resumo</div>
        ${summary}
      </section>
      <section class="rv-ov-order">
        <div class="rv-ov-k">Ordem de leitura</div>
        <div class="rv-order">${order}</div>
      </section>
    </div>
    <aside class="rv-ov-aside">
      <div class="rv-ov-k">Findings</div>
      <div class="rv-risks">${findings}</div>
      <div class="rv-ov-files">
        <div class="rv-files-h">Files ${ui.pr.files.length}</div>
        <div class="rv-grid">${files}</div>
      </div>
    </aside>
  </div>`;
}

function shimmer(n: number): string {
  const bars = Array.from({ length: n }, () => "<i></i>").join("");
  return `<div class="rv-shimmer" aria-busy="true">${bars}</div>`;
}

function findingsPanel(ui: ReviewUi): string {
  if (!ui.findings.length) return `<p class="rv-empty">Nenhum finding ainda.</p>`;
  const rows = ui.findings.map((f) => findingRow(f)).join("");
  const head = ui.head ? `<p class="rv-head">head ${escapeHtml(ui.head.slice(0, 7))}${ui.previousHead && ui.previousHead !== ui.head ? ` · era ${escapeHtml(ui.previousHead.slice(0, 7))}` : ""}</p>` : "";
  return `${head}<div class="rv-findings">${rows}</div>`;
}

function findingRow(f: ReviewFinding): string {
  const loc = f.line ? `${splitPath(f.path).name}:${f.line}` : splitPath(f.path).name;
  const statuses: FindingStatus[] = ["open", "resolved", "irrelevant"];
  const chips = statuses
    .map((s) => `<button type="button" class="rv-tri${f.status === s ? " on" : ""}" data-act="finding" data-id="${escapeHtml(f.id)}" data-value="${s}">${labelStatus(s)}</button>`)
    .join("");
  const goto = f.chapter ? ` data-rv-goto="${escapeHtml(f.chapter)}"` : "";
  const line = f.line ? ` data-rv-line="${f.line}"` : "";
  return `<div class="rv-find" data-finding="${escapeHtml(f.id)}">
    <button type="button" class="rv-find-go" data-rv-tab="Guide" data-rv-file="${escapeHtml(f.path)}"${goto}${line}>
      <span class="rv-sev rv-sev-${f.severity}" aria-label="${f.severity}"></span>
      <span><b>${escapeHtml(f.text)}</b><small>${escapeHtml(loc)}</small></span>
    </button>
    <span class="rv-triage">${chips}</span>
  </div>`;
}

function labelStatus(s: FindingStatus): string {
  switch (s) {
    case "open":
      return "aberto";
    case "resolved":
      return "resolvido";
    case "irrelevant":
      return "irrelevante";
    default: {
      const _n: never = s;
      return _n;
    }
  }
}

function orderRow(ch: ReviewChapter): string {
  const add = ch.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const del = ch.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const mark = ch.reviewed ? `<span class="done">revisado</span>` : `<span class="wait">a ler</span>`;
  return `<button type="button" class="rv-ord" data-rv-tab="Guide" data-rv-goto="${escapeHtml(ch.id)}">
    <span class="n">${String(ch.n).padStart(2, "0")}</span>
    <b>${escapeHtml(ch.title)}</b>
    <span class="rv-pm">${plusMinus(add, del)}</span>
    ${mark}
  </button>`;
}

function diagram(ui: ReviewUi): string {
  const parts: string[] = [];
  ui.diagram.nodes.forEach((n, i) => {
    const num = String(n.chapter).padStart(2, "0");
    parts.push(
      `<button type="button" class="rv-node${n.added ? " add" : ""}" data-rv-goto="${escapeHtml(`ch-${n.chapter}`)}" title="capítulo ${n.chapter}">
        <span>${escapeHtml(n.label)}</span>
        <small>${num}</small>
      </button>`,
    );
    if (i < ui.diagram.nodes.length - 1) parts.push(`<span class="rv-arrow">→</span>`);
  });
  const add = ui.diagram.additions ? `<span class="rv-a">+${ui.diagram.additions}</span>` : "";
  const title = ui.diagram.title && ui.diagram.title !== "Before / after" ? `<b>${escapeHtml(ui.diagram.title)}</b>` : "";
  return `<div class="rv-card">
    <div class="rv-card-h"><span>Before / after</span>${title}${add}</div>
    <div class="rv-flow">${parts.join("")}</div>
  </div>`;
}

function intro(ui: ReviewUi): string {
  const steps = ui.approach
    .map((s, i) => `<li><b>${i + 1}.</b> ${escapeHtml(s)}</li>`)
    .join("");
  return `<section class="rv-row" id="rv-intro">
    <div class="rv-prose">
      <h2>Overview</h2>
      <p>${escapeHtml(ui.overview)}</p>
      <ol class="rv-steps">${steps}</ol>
    </div>
    <div class="rv-code">${diagram(ui)}</div>
  </section>`;
}

function diffLines(lines: DiffLine[], fileId: string): string {
  const rows: string[] = [];
  lines.forEach((line, i) => {
    switch (line.kind) {
      case "fold": {
        const n = line.count ?? 0;
        rows.push(
          `<tr class="fold" data-rv-fold="${escapeHtml(fileId)}-${i}"><td colspan="3">${n} unmodified line${n === 1 ? "" : "s"}</td></tr>`,
        );
        if (line.folded?.length) {
          for (const inner of line.folded) rows.push(lineRow(inner, true, fileId));
        }
        break;
      }
      case "add":
      case "del":
      case "ctx":
        rows.push(lineRow(line, false, fileId));
        break;
      default: {
        const _n: never = line.kind;
        void _n;
      }
    }
  });
  return `<table class="rv-diff" data-file="${escapeHtml(fileId)}">${rows.join("")}</table>`;
}

function lineRow(line: DiffLine, hidden: boolean, fileId: string): string {
  const cls = line.kind === "add" ? "a" : line.kind === "del" ? "r" : "c";
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  const hide = hidden ? ` hidden data-fold-body` : "";
  const hunk = ` data-hunk="${line.hunk}"`;
  const newNo = line.newNo ? ` data-new="${line.newNo}"` : "";
  const lineNo = line.newNo ?? line.oldNo;
  const comment = lineNo
    ? `<button type="button" class="rv-cmt" data-act="comment-add" data-id="${escapeHtml(`${fileId}:${lineNo}`)}" aria-label="comentar">+</button>`
    : "";
  return `<tr class="${cls}"${hide}${hunk}${newNo}>
    <td class="ln">${line.oldNo ?? ""}</td>
    <td class="ln">${line.newNo ?? ""}</td>
    <td><i>${sign}</i>${escapeHtml(line.text)}${comment}</td>
  </tr>`;
}

function fileCard(ui: ReviewUi, file: { path: string; additions: number; deletions: number }): string {
  const { name, dir } = splitPath(file.path);
  const diff = ui.diffs[file.path];
  if (!diff?.lines.some((l) => l.kind === "add" || l.kind === "del")) return "";
  const reviewed = ui.fileState.find((s) => s.path === file.path)?.reviewed;
  const body = diffLines(diff.lines, file.path);
  return `<article class="rv-fc" id="file-${cssId(file.path)}" data-rv-card="${escapeHtml(file.path)}">
    <header class="rv-fh">
      <span class="rv-fn"><b>${escapeHtml(name)}</b><i>${escapeHtml(dir)}</i></span>
      <span class="rv-a">+${file.additions}</span>
      <button type="button" class="rv-chv" data-rv-hunk="prev" data-file="${escapeHtml(file.path)}" aria-label="hunk anterior">⌃</button>
      <button type="button" class="rv-chv" data-rv-hunk="next" data-file="${escapeHtml(file.path)}" aria-label="próximo hunk">⌄</button>
      <button type="button" class="rv-rev${reviewed ? " on" : ""}" data-act="review-file" data-id="${escapeHtml(file.path)}">
        <span class="box">${reviewed ? "✓" : ""}</span> Reviewed
      </button>
    </header>
    ${body}
  </article>`;
}

function cssId(path: string): string {
  return path.replace(/[^a-zA-Z0-9]+/g, "-");
}

function chapter(ui: ReviewUi, ch: ReviewChapter): string {
  const nn = String(ch.n).padStart(2, "0");
  const tt = String(ch.total).padStart(2, "0");
  const files = ch.files
    .map((f) => fileRow(f, { active: f.path === ui.activeFile, click: true }))
    .join("");
  const cards = ch.files.map((f) => fileCard(ui, f)).join("");
  return `<section class="rv-row rv-ch" id="${escapeHtml(ch.id)}" data-chapter="${ch.n}">
    <div class="rv-prose">
      <h2>${escapeHtml(ch.title)}</h2>
      <div class="rv-stat">
        <span>${nn} / ${tt}</span>
        <button type="button" class="rv-rev${ch.reviewed ? " on" : ""}" data-act="review-chapter" data-id="${escapeHtml(ch.id)}">
          <span class="box">${ch.reviewed ? "✓" : ""}</span> Reviewed
        </button>
      </div>
      <p>${escapeHtml(ch.body)}</p>
      <div class="rv-ch-files">${files}</div>
    </div>
    <div class="rv-code">${cards}</div>
  </section>`;
}

function guide(ui: ReviewUi): string {
  return `<div class="rv-guide" data-rv-panel="Guide">
    ${intro(ui)}
    ${ui.chapters.map((ch) => chapter(ui, ch)).join("")}
  </div>`;
}

function diffTab(ui: ReviewUi): string {
  return `<pre class="rv-raw" data-rv-panel="Diff">${escapeHtml(ui.pr.diff || "sem diff")}</pre>`;
}

function render(spark: Spark): string {
  const ui = uiOf(spark);
  const tabs = ["Overview", "Guide", "Diff"]
    .map((t) => `<button type="button" data-tab="${t}" class="${t === ui.tab ? "on" : ""}">${t}</button>`)
    .join("");
  return `
    <div class="rv-top">
      <div class="tabs">${tabs}</div>
      <button class="x" id="closeModal" type="button">✕</button>
    </div>
    <div class="mbody rv-body">
      ${overview(ui)}
      ${guide(ui)}
      ${diffTab(ui)}
    </div>
    <form class="mi rv-mi" id="sparkForm">
      <input name="t" placeholder="Fala com o review…" autocomplete="off" />
    </form>
    ${pendingBar(ui)}`;
}

function pendingBar(ui: ReviewUi): string {
  const n = ui.pending.length;
  const send = n
    ? `<button type="button" class="rv-send" data-act="comment-send">${n === 1 ? "enviar 1 comentário" : `enviar ${n} comentários`}</button>`
    : "";
  return `<div class="rv-loop">
    <button type="button" data-act="rereview">re-review</button>
    ${send}
  </div>`;
}

function asPr(ui: ReviewUi): PrInfo {
  return {
    number: ui.pr.number,
    title: ui.pr.title,
    body: ui.pr.body,
    author: ui.pr.author,
    additions: ui.pr.additions,
    deletions: ui.pr.deletions,
    files: ui.pr.files,
    diff: ui.pr.diff,
    headOid: ui.head,
    state: ui.prState,
  };
}

const review: ViewPlugin = {
  id: "review",
  label: "review",
  description: "Guided review: Overview / Guide / Diff, capítulos núcleo-primeiro, dados via gh.",
  tabs: ["Overview", "Guide", "Diff"],
  parseLink(params) {
    const pr = params.pr ?? params.number ?? "";
    const parsed: Record<string, string> = { pr };
    if (params.owner) parsed.owner = params.owner;
    if (params.repo) parsed.repo = params.repo;
    if (params.wt === "1") parsed.wt = "1";
    return parsed;
  },
  async createSpark(params, ctx) {
    const pr = params.pr;
    if (!pr) throw new Error("view://review precisa de ?pr=");
    const spec = params.owner && params.repo ? { owner: params.owner, repo: params.repo } : undefined;
    const info = (await ctx.fetchPr?.(pr, spec)) as PrInfo | undefined;
    const ui = info
      ? buildReviewUi(info)
      : buildReviewUi({
          number: Number(pr) || 0,
          title: `PR ${pr}`,
          body: "",
          files: [],
          diff: "",
        });
    return {
      title: `PR ${ui.pr.number} · ${ui.pr.title}`,
      needsWorktree: params.wt === "1",
      repo: ctx.repo,
      ui,
      needsUser: { kind: "review", label: "pronta pra revisar", count: 1 },
      flowStep: "spark",
      prompt: `Você está no modo review do NCLI, PR ${pr}.
Dados já vieram de gh pr view --json + gh pr diff. Percorra os capítulos na ordem núcleo → API → glue → db → gerados → testes.
Não misture produção e testes no mesmo capítulo.

Quando tiver um plano, emita UM bloco json (e nada mais nesse bloco) com:
\`\`\`json
{"overview":"...","summary":"...","risks":[{"severity":"high","text":"...","path":"src/file.ts","line":12}],"approach":["...","...","...","..."],"diagram":{"title":"...","additions":0,"nodes":[{"id":"a","label":"fn()","chapter":1,"added":true}],"edges":[["a","b"]]},"chapters":[{"title":"...","body":"...","files":["path"]}]}
\`\`\`
Se não puder, não invente paths. O hub já tem um fallback.`,
    };
  },
  async applyAction(spark, action: ViewAction, ctx): Promise<ViewActionResult | void> {
    const ui = uiOf(spark);
    switch (action.type) {
      case "review-chapter":
        return { ui: toggleReviewed(ui, "chapter", action.id ?? ""), needsUser: spark.needsUser };
      case "review-file":
        return { ui: toggleReviewed(ui, "file", action.id ?? ""), needsUser: spark.needsUser };
      case "comment-add": {
        const loc = commentId(action.id);
        if (!loc) return;
        return { ui: addComment(ui, loc.path, loc.line, action.value ?? ""), needsUser: spark.needsUser };
      }
      case "comment-send": {
        if (!ui.pending.length) return;
        const sent = sendComments(ui);
        return { ui: sent.ui, ask: sent.ask, note: findingsFence(sent.ui.findings), needsUser: spark.needsUser };
      }
      case "finding": {
        const status = action.value;
        if (status !== "open" && status !== "resolved" && status !== "irrelevant") return;
        return { ui: setFindingStatus(ui, action.id ?? "", status), needsUser: spark.needsUser };
      }
      case "rereview": {
        const pr = spark.params.pr;
        if (!pr || !ctx?.fetchPr) return;
        const spec = spark.params.owner && spark.params.repo
          ? { owner: spark.params.owner, repo: spark.params.repo }
          : undefined;
        try {
          const info = (await ctx.fetchPr(pr, spec)) as PrInfo;
          const next = applyRereview(ui, info);
          return { ui: next, note: findingsFence(next.findings), needsUser: spark.needsUser };
        } catch {
          return;
        }
      }
      case "say":
        return;
      default:
        return;
    }
  },
  onEvent(spark, event) {
    if (!event.text) return;
    const plan = extractPlan(event.text);
    if (!plan) return;
    const ui = uiOf(spark);
    const next = buildReviewUi(asPr(ui), plan);
    next.fileState = ui.fileState;
    next.chapters.forEach((ch, i) => {
      ch.reviewed = ui.chapters[i]?.reviewed ?? false;
    });
    next.findings = mergeFindings(ui.findings, next.findings);
    next.pending = ui.pending;
    next.head = ui.head ?? next.head;
    next.prState = ui.prState ?? next.prState;
    return { ui: next, flowStep: "wait", note: next.findings.length ? findingsFence(next.findings) : undefined };
  },
  result(spark): SparkResult {
    const ui = uiOf(spark);
    return {
      summary: ui.overview || ui.pr.title,
      artifacts: ui.chapters.map((ch) => ({ kind: "chapter", label: ch.title, text: ch.body })),
      decisions: ui.chapters.filter((ch) => ch.reviewed).map((ch) => ({ id: ch.id, text: ch.title })),
      links: [`view://review?pr=${ui.pr.number}`],
    };
  },
  render,
};

export default review;
