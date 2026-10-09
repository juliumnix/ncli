import type { Fork, ForkStatus } from "../types";

export function railForks(forks: Fork[]): Fork[] {
  return forks.filter((f) => f.status === "running" || f.status === "needs_user" || f.status === "done");
}

export function pillClass(opts: { fresh: boolean; status: ForkStatus }): string {
  const parts = ["ch"];
  if (opts.fresh) parts.push("pop");
  if (opts.status === "needs_user" || opts.status === "done") parts.push("attn");
  return parts.join(" ");
}
