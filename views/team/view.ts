import type { Spark } from "../../src/types";
import { repoParts, parseTeamPrs, teamTitle, type TeamBoard, type TeamPr } from "../../src/team/model";
import { escapeHtml } from "../../src/util";
import type { SparkResult } from "../../src/views/manifest";
import type { ViewPlugin } from "../../src/views/types";

function boardOf(spark: Spark): TeamBoard {
  const ui = spark.ui as TeamBoard | undefined;
  if (ui && Array.isArray(ui.prs)) return ui;
  return { owner: "", repo: "", privateRepo: true, prs: [] };
}

function asPrs(raw: unknown): TeamPr[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const o = row as Record<string, unknown>;
    const number = Number(o.number);
    if (!Number.isFinite(number) || number <= 0) return [];
    const who = o.author;
    const author =
      who && typeof who === "object"
        ? String((who as { login?: string; name?: string }).login ?? (who as { name?: string }).name ?? "")
        : String(who ?? "");
    return [
      {
        number,
        title: String(o.title ?? `#${number}`),
        author,
        url: String(o.url ?? ""),
        draft: o.draft === true || o.isDraft === true,
      },
    ];
  });
}

function rowHtml(pr: TeamPr, board: TeamBoard): string {
  const href = pr.url || `view://review?pr=${pr.number}&owner=${encodeURIComponent(board.owner)}&repo=${encodeURIComponent(board.repo)}`;
  const draft = pr.draft ? ` <span class="mute">draft</span>` : "";
  const who = pr.author ? ` · ${escapeHtml(pr.author)}` : "";
  return `<li><a href="${escapeHtml(href)}">#${pr.number} ${escapeHtml(pr.title)}</a>${who}${draft}</li>`;
}

const plugin: ViewPlugin = {
  id: "team",
  label: "team",
  description: "PRs abertos do time neste repo, inclusive privado.",
  tabs: ["PRs"],
  parseLink(params) {
    return params;
  },
  async createSpark(params, ctx) {
    const { owner, repo } = repoParts(ctx?.repo ?? "", params.owner, params.repo);
    const listed = params.prs ? parseTeamPrs(params.prs) : asPrs(await ctx?.listPrs?.({ owner, repo }));
    const board: TeamBoard = {
      owner,
      repo,
      privateRepo: params.private !== "0",
      prs: listed,
    };
    return {
      title: teamTitle(board),
      prompt: `Modo team. ${teamTitle(board)}. Lista os PRs abertos, inclusive de repo privado. Não feche o spark.`,
      needsWorktree: false,
      hold: true,
      needsUser: { kind: "review", label: teamTitle(board), count: board.prs.length },
      ui: board,
      flowStep: "spark",
    };
  },
  render(spark) {
    const board = boardOf(spark);
    const rows = board.prs.map((pr) => rowHtml(pr, board)).join("") || `<li class="mute">nenhum PR aberto</li>`;
    const lock = board.privateRepo ? " · privado" : "";
    return `
      <div class="mh">
        <b>team #${spark.seq}</b> ${escapeHtml(teamTitle(board))}${lock}
        <button class="x" id="closeModal" type="button">✕</button>
      </div>
      <div class="mbody"><ul class="team-prs">${rows}</ul></div>
      <form class="mi" id="sparkForm">
        <input name="t" placeholder="Fala com o team…" autocomplete="off" />
      </form>`;
  },
  result(spark: Spark): SparkResult {
    const board = boardOf(spark);
    return {
      summary: teamTitle(board),
      artifacts: [],
      decisions: [],
      links: board.prs.map((pr) => pr.url || `view://review?pr=${pr.number}`),
    };
  },
};

export default plugin;
