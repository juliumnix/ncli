import type { Fork, NeedsUser } from "../types";
import type { ForkResult } from "./manifest";

export interface ViewCreateResult {
  title: string;
  prompt: string;
  repo?: string;
  needsWorktree: boolean;
  ui?: unknown;
  needsUser?: Fork["needsUser"];
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
  result?: ForkResult;
  flowStep?: string;
}

export interface ViewPlugin {
  id: string;
  label: string;
  description: string;
  tabs: string[];
  parseLink?(params: Record<string, string>): Record<string, string>;
  createFork(params: Record<string, string>, ctx: ViewCreateCtx): Promise<ViewCreateResult>;
  applyAction?(fork: Fork, action: ViewAction): ViewActionResult | void;
  render?(fork: Fork): string;
  onEvent?(fork: Fork, event: { type: string; text?: string }): Partial<Fork> | void;
  result?(fork: Fork): ForkResult;
}

export interface ViewCreateCtx {
  dataDir: string;
  repo: string;
  fetchPr?: (pr: string) => Promise<unknown>;
}
