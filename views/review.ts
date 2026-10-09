import type { Fork } from "../src/types";
import type { ViewAction, ViewActionResult, ViewPlugin } from "../src/views/types";
import type { PrInfo } from "../src/gh/pr";
import {
  buildReviewUi,
  extractPlan,
  splitPath,
  toggleReviewed,
  type DiffLine,
  type ReviewChapter,
  type ReviewUi,
} from "../src/review/model";
import { escapeHtml } from "../src/util";

function uiOf(fork: Fork): ReviewUi {
  return fork.ui as ReviewUi;
}

function fileIcon(path: string): string {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const map: Record<string, [string, string]> = {
    ts: ["TS", "#3b82f6"],
    tsx: ["TS", "#3b82f6"],
    js: ["JS", "#ca8a04"],
    json: ["{}", "#d97706"],
    md: ["MD", "#7c83ff"],
    swift: ["S", "#f05138"],
  };
  const [label, color] = map[ext] ?? [(ext.slice(0, 2) || "·").toUpperCase(), "#a3a3a3"];
  return `<span class="rv-ico" style="background:${color}">${escapeHtml(label)}</span>`;
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
  const files = ui.pr.files.map((f) => fileRow(f)).join("");
  return `<div class="rv-overview" data-rv-panel="Overview">
    <h1>${escapeHtml(ui.pr.title)}</h1>
    <div class="rv-meta">
      <span>${escapeHtml(ui.pr.author)}</span>
      <span class="dot"></span>
      <span>#${ui.pr.number}</span>
      <span class="dot"></span>
      <span class="rv-a">+${ui.pr.additions}</span>
      <span class="rv-d">−${ui.pr.deletions}</span>
    </div>
    <div class="rv-files-h">Files ${ui.pr.files.length}</div>
    <div class="rv-grid">${files}</div>
  </div>`;
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
          for (const inner of line.folded) rows.push(lineRow(inner, true));
        }
        break;
      }
      case "add":
      case "del":
      case "ctx":
        rows.push(lineRow(line, false));
        break;
      default: {
        const _n: never = line.kind;
        void _n;
      }
    }
  });
  return `<table class="rv-diff" data-file="${escapeHtml(fileId)}">${rows.join("")}</table>`;
}

function lineRow(line: DiffLine, hidden: boolean): string {
  const cls = line.kind === "add" ? "a" : line.kind === "del" ? "r" : "c";
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  const hide = hidden ? ` hidden data-fold-body` : "";
  const hunk = ` data-hunk="${line.hunk}"`;
  return `<tr class="${cls}"${hide}${hunk}>
    <td class="ln">${line.oldNo ?? ""}</td>
    <td class="ln">${line.newNo ?? ""}</td>
    <td><i>${sign}</i>${escapeHtml(line.text)}</td>
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

function render(fork: Fork): string {
  const ui = uiOf(fork);
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
    <form class="mi rv-mi" id="forkForm">
      <input name="t" placeholder="Fala com o review…" autocomplete="off" />
    </form>`;
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
  };
}

const review: ViewPlugin = {
  id: "review",
  label: "review",
  description: "Guided review: Overview / Guide / Diff, capítulos núcleo-primeiro, dados via gh.",
  tabs: ["Overview", "Guide", "Diff"],
  parseLink(params) {
    return { pr: params.pr ?? params.number ?? "" };
  },
  async createFork(params, ctx) {
    const pr = params.pr;
    if (!pr) throw new Error("view://review precisa de ?pr=");
    const info = (await ctx.fetchPr?.(pr)) as PrInfo | undefined;
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
      needsWorktree: false,
      repo: ctx.repo,
      ui,
      needsUser: { kind: "review", label: "pronta pra revisar", count: 1 },
      prompt: `Você está no modo review do NCLI, PR ${pr}.
Dados já vieram de gh pr view --json + gh pr diff. Percorra os capítulos na ordem núcleo → API → glue → db → gerados → testes.
Não misture produção e testes no mesmo capítulo.

Quando tiver um plano, emita UM bloco json (e nada mais nesse bloco) com:
\`\`\`json
{"overview":"...","approach":["...","...","...","..."],"diagram":{"title":"...","additions":0,"nodes":[{"id":"a","label":"fn()","chapter":1,"added":true}],"edges":[["a","b"]]},"chapters":[{"title":"...","body":"...","files":["path"]}]}
\`\`\`
Se não puder, não invente paths. O hub já tem um fallback.`,
    };
  },
  applyAction(fork, action: ViewAction): ViewActionResult | void {
    const ui = uiOf(fork);
    switch (action.type) {
      case "review-chapter":
        return { ui: toggleReviewed(ui, "chapter", action.id ?? ""), needsUser: fork.needsUser };
      case "review-file":
        return { ui: toggleReviewed(ui, "file", action.id ?? ""), needsUser: fork.needsUser };
      case "say":
        return;
      default:
        return;
    }
  },
  onEvent(fork, event) {
    if (!event.text) return;
    const plan = extractPlan(event.text);
    if (!plan) return;
    const ui = uiOf(fork);
    const next = buildReviewUi(asPr(ui), plan);
    next.fileState = ui.fileState;
    next.chapters.forEach((ch, i) => {
      ch.reviewed = ui.chapters[i]?.reviewed ?? false;
    });
    return { ui: next };
  },
  render,
};

export default review;
