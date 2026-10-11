import type { Spark, SparkStatus } from "../types";

export function railSparks(sparks: Spark[]): Spark[] {
  return sparks.filter((f) => f.status === "running" || f.status === "needs_user" || f.status === "done");
}

export function pillClass(opts: { fresh: boolean; status: SparkStatus }): string {
  const parts = ["ch"];
  if (opts.fresh) parts.push("pop");
  if (opts.status === "needs_user" || opts.status === "done") parts.push("attn");
  return parts.join(" ");
}
