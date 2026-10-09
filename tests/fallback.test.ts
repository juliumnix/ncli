import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness, HarnessEvent, RunOpts } from "../src/harness/types";
import { isQuotaError } from "../src/harness/quota";
import { makeHub } from "./helpers";

class QuotaClaude implements Harness {
  readonly id = "claude";
  async *run(_opts: RunOpts): AsyncIterable<HarnessEvent> {
    yield { type: "error", error: "Claude API Error: 429 rate_limit quota exceeded" };
  }
}

test("isQuotaError matches rate-limit and quota text", () => {
  expect(isQuotaError("HTTP 429 rate limit exceeded")).toBe(true);
  expect(isQuotaError("you've hit your usage limit")).toBe(true);
  expect(isQuotaError("syntax error")).toBe(false);
});

test("Claude quota switches main harness to the backup, announces it, and retries the turn", async () => {
  const { hub } = await makeHub({ harness: new QuotaClaude() });
  hub.cfg.backupHarness = "mock";
  try {
    await hub.send("continua o desconto");
    expect(hub.harness.id).toBe("mock");
    const texts = hub.memory.log.map((m) => m.text).join("\n");
    expect(texts).toMatch(/Claude bateu no limite/);
    expect(texts).toMatch(/harness principal para mock/);
    expect(hub.memory.log.some((m) => m.kind === "talk" && /Ok\.|desconto|Pode mandar/i.test(m.text))).toBe(true);
    expect(readFileSync(join(hub.cfg.dataDir, "main-harness"), "utf8").trim()).toBe("mock");
  } finally {
    hub.close();
  }
});
