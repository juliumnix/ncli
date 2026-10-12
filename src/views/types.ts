import type { Spark, NeedsUser } from "../types";
import type { SparkResult } from "./manifest";

export interface ViewCreateResult {
  title: string;
  prompt: string;
  repo?: string;
  needsWorktree: boolean;
  ui?: unknown;
  needsUser?: Spark["needsUser"];
  hold?: boolean;
  flowStep?: string;
}

export interface ViewAction {
  type: string;
  id?: string;
  value?: string;
}

export interface ViewActionResult {
  ui?: unknown;
  needsUser?: NeedsUser | null;
  merge?: boolean;
  summary?: string;
  result?: SparkResult;
  flowStep?: string;
  ask?: string;
  note?: string;
}

export interface ViewPlugin {
  id: string;
  label: string;
  description: string;
  tabs: string[];
  parseLink?(params: Record<string, string>): Record<string, string>;
  createSpark(params: Record<string, string>, ctx: ViewCreateCtx): Promise<ViewCreateResult>;
  applyAction?(
    spark: Spark,
    action: ViewAction,
    ctx?: ViewCreateCtx,
  ): ViewActionResult | void | Promise<ViewActionResult | void>;
  render?(spark: Spark): string;
  onEvent?(spark: Spark, event: { type: string; text?: string }): (Partial<Spark> & { note?: string }) | void;
  result?(spark: Spark): SparkResult;
}

export interface ViewCreateCtx {
  dataDir: string;
  repo: string;
  fetchPr?: (pr: string, spec?: { owner?: string; repo?: string }) => Promise<unknown>;
  listPrs?: (spec?: { owner?: string; repo?: string }) => Promise<unknown>;
}
