import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isQuotaError, parseQuota, parseResetAt } from "../src/harness/quota";
import { parseFallbackChain, UsageBoard } from "../src/harness/usage";
import { makeHub } from "./helpers";
import type { Harness, HarnessEvent, RunOpts } from "../src/harness/types";

test("parseResetAt reads ISO, relative, and clock forms", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");
  expect(parseResetAt("retry after 2026-10-11T15:30:00Z", now)).toBe(Date.parse("2026-10-11T15:30:00Z"));
  expect(parseResetAt("rate limit, try again in 5 hours", now)).toBe(now + 5 * 3600_000);
  expect(parseResetAt("usage limit resets at 3:00 PM", now)).toBeDefined();
  expect(parseResetAt("syntax error", now)).toBeUndefined();
  expect(parseResetAt("quota exceeded, retry in 40ms", now)).toBe(now + 40);
});

test("parseQuota is a quota hit only when isQuotaError matches", () => {
  expect(isQuotaError("HTTP 429 rate limit exceeded")).toBe(true);
  const hit = parseQuota("Claude API Error: 429 quota exceeded, resets at 2026-10-11T15:00:00Z");
  expect(hit.limited).toBe(true);
  if (hit.limited) expect(hit.resetAt).toBe("2026-10-11T15:00:00.000Z");
  expect(parseQuota("syntax error").limited).toBe(false);
});

test("fallback chain prefers NCLI_FALLBACK then backup", () => {
  expect(parseFallbackChain("codex,cursor", "claude")).toEqual(["codex", "cursor"]);
  expect(parseFallbackChain(undefined, "codex")).toEqual(["codex", "claude", "cursor"]);
});

test("UsageBoard walks the chain and persists limited seats", () => {
  const dir = mkdtempSync(join(tmpdir(), "ncli-usage-"));
  const board = new UsageBoard(dir, ["claude", "codex", "cursor"]);
  board.markLimited("claude", "429 quota exceeded, retry in 5 hours");
  expect(board.nextOpen("claude")).toBe("codex");
  expect(board.nextOpen("claude", { claude: true, codex: false, cursor: true })).toBe("cursor");
  expect(board.snapshot("claude", { claude: true, codex: true, cursor: false }).next).toBe("codex");
  board.markLimited("codex", "429 quota exceeded");
  expect(board.nextOpen("claude")).toBe("cursor");
  board.markLimited("cursor", "429 quota exceeded");
  expect(board.nextOpen("claude")).toBeUndefined();
  const again = new UsageBoard(dir, ["claude", "codex", "cursor"]);
  expect(again.limitOf("claude").status).toBe("limited");
  expect(again.limitOf("codex").status).toBe("limited");
  again.close();
  board.close();
});

test("one timer fires resume and skips snooze", () => {
  const dir = mkdtempSync(join(tmpdir(), "ncli-usage-"));
  let now = 1_000;
  const pending: Array<{ fn: () => void; at: number }> = [];
  const fired: string[] = [];
  const board = new UsageBoard(dir, ["claude", "codex"], {
    now: () => now,
    schedule: (fn, ms) => {
      pending.push({ fn, at: now + ms });
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clear: () => {
      pending.length = 0;
    },
  });
  board.onReset = (seat) => fired.push(seat);
  board.markLimited("claude", "429 quota, retry in 40ms");
  board.setPolicy("codex", "snooze");
  board.markLimited("codex", "429 quota, retry in 40ms");
  now = 1_040;
  pending.pop()?.fn();
  expect(fired).toEqual(["claude"]);
  expect(board.limitOf("claude").status).toBe("ok");
  expect(board.limitOf("codex").status).toBe("limited");
  board.close();
});

class QuotaSeat implements Harness {
  constructor(
    readonly id: "claude" | "codex" | "cursor",
    private readonly error: string,
  ) {}
  async *run(_opts: RunOpts): AsyncIterable<HarnessEvent> {
    yield { type: "error", error: this.error };
  }
}

test("quota walks claude → backup and announces Limited when the chain is exhausted", async () => {
  const { hub } = await makeHub({
    harness: new QuotaSeat("claude", "429 quota exceeded"),
    backupHarness: "mock",
    fallbackChain: ["claude", "mock"],
  });
  try {
    await hub.send("continua o desconto");
    expect(hub.harness.id).toBe("mock");
    expect(hub.usage.limitOf("claude").status).toBe("limited");
    expect(hub.snapshot().usage.seats.some((s) => s.seat === "claude" && s.status === "limited")).toBe(true);
    const texts = hub.memory.log.map((m) => m.text).join("\n");
    expect(texts).toMatch(/limite/);
    expect(texts).toMatch(/mock/);
  } finally {
    hub.close();
  }
});

class OnceQuota implements Harness {
  readonly id = "claude";
  hits = 0;
  async *run(_opts: RunOpts): AsyncIterable<HarnessEvent> {
    if (this.hits++ === 0) {
      yield { type: "error", error: "429 quota exceeded, retry in 80ms" };
      return;
    }
    yield { type: "text", text: "voltei do reset" };
    yield { type: "done", text: "voltei do reset" };
  }
}

test("exhausted chain parks the next line and a resume reset drains it", async () => {
  const harness = new OnceQuota();
  const { hub } = await makeHub({ harness, backupHarness: "claude", fallbackChain: ["claude"] });
  try {
    await hub.send("primeira");
    expect(hub.usage.limitOf("claude").status).toBe("limited");
    await hub.send("segunda, fica na fila");
    expect(hub.queue.list("main").some((i) => i.text === "segunda, fica na fila")).toBe(true);
    await Bun.sleep(200);
    expect(hub.usage.limitOf("claude").status).toBe("ok");
    expect(hub.queue.list("main").some((i) => i.text === "segunda, fica na fila")).toBe(false);
    expect(hub.memory.log.some((m) => m.kind === "talk" && m.text.includes("voltei do reset"))).toBe(true);
  } finally {
    hub.close();
  }
});

test("limit chip names the next open seat", () => {
  const js = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  expect(js).toContain("próximo");
  expect(js).toContain("state.usage.next");
});
