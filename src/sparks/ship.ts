import { inspectWorktree, type GitRunner, type WorktreeHandle, type WorktreeStatus } from "./worktree";

export type ShipKind = "idle" | "commit" | "open-pr";

export type ShipPlan = {
  kind: ShipKind;
  label: string;
  title: string;
  files: string[];
};

export type OpenPr = (opts: { cwd: string; title: string; head: string }) => Promise<{ url: string }>;

export type FindPr = (opts: { cwd: string; head: string }) => Promise<{ url: string } | null>;

export type ShipResult = {
  ok: boolean;
  plan: ShipPlan;
  url?: string;
  error?: string;
};

const inflight = new Map<string, Promise<ShipResult>>();

export function planShip(status: WorktreeStatus, title: string): ShipPlan {
  const clean = title.trim() || "ncli";
  if (status.dirty) return { kind: "commit", label: "commit e PR", title: clean, files: status.files };
  if (status.unpushed) return { kind: "open-pr", label: "abrir PR", title: clean, files: [] };
  return { kind: "idle", label: "enviado", title: clean, files: [] };
}

export async function runShip(opts: {
  handle: WorktreeHandle;
  title: string;
  git: GitRunner;
  openPr: OpenPr;
  findPr?: FindPr;
}): Promise<ShipResult> {
  const key = opts.handle.path;
  const pending = inflight.get(key);
  if (pending) return pending;
  const work = runShipOnce(opts).finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

async function runShipOnce(opts: {
  handle: WorktreeHandle;
  title: string;
  git: GitRunner;
  openPr: OpenPr;
  findPr?: FindPr;
}): Promise<ShipResult> {
  const status = await inspectWorktree(opts.handle, opts.git);
  const plan = planShip(status, opts.title);
  if (plan.kind === "idle") return { ok: true, plan };
  const cwd = opts.handle.path;
  const head = opts.handle.branch;
  const branched = await opts.git(["checkout", "-B", head], cwd);
  if (branched.code !== 0) return { ok: false, plan, error: branched.stderr.trim() || "checkout" };
  if (plan.kind === "commit") {
    const add = await opts.git(["add", "-A"], cwd);
    if (add.code !== 0) return { ok: false, plan, error: add.stderr.trim() || "add" };
    const commit = await opts.git(["commit", "-m", plan.title], cwd);
    if (commit.code !== 0) return { ok: false, plan, error: commit.stderr.trim() || "commit" };
  }
  const push = await opts.git(["push", "-u", "origin", head], cwd);
  if (push.code !== 0) return { ok: false, plan, error: push.stderr.trim() || "push" };
  try {
    const existing = await opts.findPr?.({ cwd, head });
    if (existing?.url) return { ok: true, plan: { ...plan, kind: "idle", label: "enviado" }, url: existing.url };
    const pr = await opts.openPr({ cwd, title: plan.title, head });
    return { ok: true, plan, url: pr.url };
  } catch (err) {
    return { ok: false, plan, error: err instanceof Error ? err.message : String(err) };
  }
}
