import type { Message } from "./types";

export const STATE_PAGE = 80;
export const STATE_PAGE_MAX = 200;

export type MessagePage = {
  messages: Message[];
  before: number | null;
  hasMore: boolean;
  messageCount: number;
};

export type StatePageOpts = {
  before?: number;
  limit?: number;
};

export function pageLimit(limit?: number): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return STATE_PAGE;
  return Math.min(STATE_PAGE_MAX, Math.floor(n));
}

export function pageMessages(log: readonly Message[], opts: StatePageOpts = {}): MessagePage {
  const limit = pageLimit(opts.limit);
  const end = opts.before == null || !Number.isFinite(opts.before)
    ? log.length
    : Math.max(0, Math.min(log.length, Math.floor(opts.before)));
  const start = Math.max(0, end - limit);
  return {
    messages: log.slice(start, end) as Message[],
    before: start > 0 ? start : null,
    hasMore: start > 0,
    messageCount: log.length,
  };
}
