import { expect, test } from "bun:test";
import { bootNcli } from "../src/boot";
import { buildClaudeArgs } from "../src/acp/claude";
import { loadConfig } from "../src/config";
import { makeHub, tmpDir, waitUntil } from "./helpers";

test("POST /api/message returns before the turn finishes and SSE streams tokens", async () => {
  const { hub } = await makeHub();
  hub.cfg.port = 19200 + Math.floor(Math.random() * 1000);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  try {
    const es = await fetch(`${booted.report.uiUrl}/api/events`);
    const reader = es.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const events: Array<{ type?: string; text?: string; turn?: { status?: string } }> = [];
    const pump = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.replace(/^data: /, "");
          if (!line.trim()) continue;
          try {
            events.push(JSON.parse(line) as { type?: string });
          } catch {
            continue;
          }
        }
        if (events.some((e) => e.type === "message" && (e as { message?: { kind?: string } }).message?.kind === "talk")) break;
      }
    })();

    const started = Date.now();
    const res = await fetch(`${booted.report.uiUrl}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "oi" }),
    });
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(true);
    expect(elapsed).toBeLessThan(400);
    await pump;
    expect(events.some((e) => e.type === "turn")).toBe(true);
    expect(events.some((e) => e.type === "delta" && (e.text ?? "").length > 0)).toBe(true);
    await waitUntil(() => hub.memory.log.some((m) => m.kind === "talk"));
    expect(hub.snapshot().main.harness).toBe("mock");
  } finally {
    booted.stop();
  }
});

test("claude -p requests partial messages so tokens can stream", () => {
  const cfg = loadConfig({ dataDir: tmpDir("partial"), claudeBin: "claude" });
  const args = buildClaudeArgs(cfg, { prompt: "oi" });
  expect(args).toContain("--include-partial-messages");
  expect(args.slice(0, 5)).toEqual(["claude", "-p", "--output-format", "stream-json", "--verbose"]);
});

test("POST /api/harness switches the main agent and snapshot shows it", async () => {
  const { hub } = await makeHub();
  hub.cfg.port = 19300 + Math.floor(Math.random() * 1000);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  try {
    const res = await fetch(`${booted.report.uiUrl}/api/harness`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: "codex" }),
    });
    const json = await res.json() as { main: { harness: string } };
    expect(json.main.harness).toBe("codex");
    expect(hub.snapshot().main.harness).toBe("codex");
  } finally {
    booted.stop();
  }
});
