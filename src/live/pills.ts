import type { Spark, SparkStatus } from "../types";
import { inboxRows } from "./inbox";

export function railSparks(sparks: Spark[]): Spark[] {
  const ids = new Set(inboxRows(sparks).map((r) => r.id));
  return sparks.filter((s) => ids.has(s.id));
}

export function pillClass(opts: { fresh: boolean; status: SparkStatus }): string {
  const parts = ["ch"];
  if (opts.fresh) parts.push("pop");
  if (opts.status === "needs_user" || opts.status === "done") parts.push("attn");
  return parts.join(" ");
}
