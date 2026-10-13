import { expect, test } from "bun:test";
import { bootNcli } from "../src/boot";
import { buildClaudeArgs } from "../src/acp/claude";
import { loadConfig } from "../src/config";
import { makeHub, tmpDir, waitUntil } from "./helpers";

test("a second send while turning still opens view:// links", async () => {
  const { hub } = await makeHub();
  const first = hub.send("oi");
  await waitUntil(() => hub.snapshot().turning);
  await hub.send("view://live");
  await waitUntil(() => hub.sparks.list().some((f) => f.view === "live"));
  await first;
});

test("the running turn is emitted before the first token", async () => {
  const { hub } = await makeHub();
  const types: string[] = [];
  hub.subscribe((ev) => types.push(ev.type));
  const started = performance.now();
  const send = hub.send("oi");
  await waitUntil(() => types.includes("turn"));
  expect(performance.now() - started).toBeLessThan(80);
  await waitUntil(() => types.includes("delta"));
  expect(types.indexOf("turn")).toBeLessThan(types.indexOf("delta"));
  await send;
});

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
  expect(args).toContain("--input-format");
  expect(args.slice(0, 5)).toEqual(["claude", "-p", "--output-format", "stream-json", "--verbose"]);
  expect(args).not.toContain("oi");
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
