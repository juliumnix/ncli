export type TeamPr = {
  number: number;
  title: string;
  author: string;
  url: string;
  draft: boolean;
};

export type TeamBoard = {
  owner: string;
  repo: string;
  privateRepo: boolean;
  prs: TeamPr[];
};

export function teamTitle(board: TeamBoard): string {
  const n = board.prs.length;
  const name = board.owner && board.repo ? `${board.owner}/${board.repo}` : "o repo";
  return n === 1 ? `1 PR em ${name}` : `${n} PRs em ${name}`;
}

export function parseTeamPrs(raw: string | undefined): TeamPr[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const o = row as Record<string, unknown>;
      const number = Number(o.number);
      if (!Number.isFinite(number) || number <= 0) return [];
      return [
        {
          number,
          title: String(o.title ?? `#${number}`),
          author: String(o.author ?? ""),
          url: String(o.url ?? ""),
          draft: o.draft === true,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function repoParts(repoPath: string, owner?: string, repo?: string): { owner: string; repo: string } {
  if (owner && repo) return { owner, repo };
  const bits = repoPath.replace(/\/$/, "").split("/");
  const name = bits.at(-1) ?? "";
  const org = bits.at(-2) ?? "";
  return { owner: owner || org, repo: repo || name };
}
