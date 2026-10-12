import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export type PrState = "OPEN" | "MERGED" | "CLOSED";

export interface PrInfo {
  number: number;
  title: string;
  body: string;
  url?: string;
  baseRefName?: string;
  headRefName?: string;
  headOid?: string;
  state?: PrState;
  additions?: number;
  deletions?: number;
  author?: string | { login?: string; name?: string };
  files: PrFile[];
  diff: string;
}

export type GhPrSpec = { owner?: string; repo?: string };

const PR_JSON_FIELDS =
  "number,title,body,url,baseRefName,headRefName,headRefOid,state,additions,deletions,files,author";

export function ghRepoFlags(spec?: GhPrSpec): string[] {
  if (!spec?.owner || !spec?.repo) return [];
  return ["--repo", `${spec.owner}/${spec.repo}`];
}

export function ghViewArgs(pr: string, spec?: GhPrSpec): string[] {
  return ["pr", "view", pr, "--json", PR_JSON_FIELDS, ...ghRepoFlags(spec)];
}

export interface GhClient {
  view(pr: string, spec?: GhPrSpec): Promise<PrInfo>;
}

export class RealGh implements GhClient {
  constructor(private readonly cwd: string) {}
  async view(pr: string, spec?: GhPrSpec): Promise<PrInfo> {
    const json = await gh(ghViewArgs(pr, spec), this.cwd);
    const meta = JSON.parse(json) as {
      number: number;
      title: string;
      body: string;
      url?: string;
      baseRefName?: string;
      headRefName?: string;
      headRefOid?: string;
      state?: PrState;
      additions?: number;
      deletions?: number;
      author?: string | { login?: string; name?: string };
      files?: Array<{ path: string; additions: number; deletions: number }>;
    };
    const diff = await gh(["pr", "diff", pr, ...ghRepoFlags(spec)], this.cwd);
    return {
      number: meta.number,
      title: meta.title,
      body: meta.body ?? "",
      url: meta.url,
      baseRefName: meta.baseRefName,
      headRefName: meta.headRefName,
      headOid: meta.headRefOid,
      state: meta.state,
      additions: meta.additions,
      deletions: meta.deletions,
      author: meta.author,
      files: (meta.files ?? []).map((f) => ({
        path: f.path,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      })),
      diff,
    };
  }
}

export class FixtureGh implements GhClient {
  constructor(private readonly dir: string) {}
  async view(pr: string, _spec?: GhPrSpec): Promise<PrInfo> {
    const jsonPath = join(this.dir, `pr-${pr}.json`);
    const diffPath = join(this.dir, `pr-${pr}.diff`);
    if (!existsSync(jsonPath)) throw new Error(`sem fixture gh pra PR ${pr}`);
    const meta = JSON.parse(readFileSync(jsonPath, "utf8")) as PrInfo;
    meta.diff = existsSync(diffPath) ? readFileSync(diffPath, "utf8") : meta.diff ?? "";
    return meta;
  }
}

export class AutoGh implements GhClient {
  constructor(
    private readonly real: GhClient,
    private readonly fixtures: GhClient,
  ) {}
  async view(pr: string, spec?: GhPrSpec): Promise<PrInfo> {
    try {
      return await this.real.view(pr, spec);
    } catch {
      return this.fixtures.view(pr, spec);
    }
  }
}

async function gh(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.trim() || `gh ${args.join(" ")} exit ${code}`);
  return stdout;
}
