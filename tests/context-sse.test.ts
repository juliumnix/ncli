import { expect, test } from "bun:test";
import { bootNcli } from "../src/boot";
import { contextRows } from "../src/memory/context";
import { Memory } from "../src/memory/store";
import type { ContextRow, ContextSnapshot, HubEvent } from "../src/types";
import { makeHub, tmpDir, waitUntil } from "./helpers";

test("onChange emits a pending context row then a built merge", async () => {
  const snaps: ContextRow[][] = [];
  const mem = new Memory({
    dir: tmpDir("ctx-live"),
    nodeBytes: 40,
    viewBytes: 50,
    compressor: async (input) => {
      await Bun.sleep(15);
      return input.source.slice(0, 28);
    },
  });
  mem.onChange = () => snaps.push(contextRows(mem));
  mem.append({ kind: "talk", text: "ALPHA_LIVE " + "x".repeat(120) });
  expect(snaps[0]?.[0]?.n).toBe(1);
  expect(snaps[0]?.[0]?.built).toBe(false);
  mem.append({ kind: "talk", text: "BETA_LIVE " + "x".repeat(120) });
  await waitUntil(() => snaps.some((rows) => rows.some((r) => r.n >= 2 && r.built)), 3000);
  expect(assembleUnchanged(mem.viewLines())).toBe(true);
});

test("GET /api/events hello-burst includes a context snapshot and later a merge", async () => {
  const { hub } = await makeHub({ viewBytes: 50, nodeBytes: 40 });
  hub.cfg.port = 19400 + Math.floor(Math.random() * 800);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  try {
    const es = await fetch(`${booted.report.uiUrl}/api/events`);
    const reader = es.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const events: HubEvent[] = [];
    const pump = (async () => {
      while (true) {
        let value: Uint8Array | undefined;
        try {
          const next = await reader.read();
          value = next.value;
          if (next.done) break;
        } catch {
          break;
        }
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.replace(/^data: /, "");
          if (!line.trim()) continue;
          try {
            events.push(JSON.parse(line) as HubEvent);
          } catch {
            continue;
          }
        }
        if (events.some((e) => e.type === "context" && e.rows.some((r) => r.n >= 2 && r.built))) break;
      }
    })();
    await waitUntil(() => events.some((e) => e.type === "context"), 2000);
    expect(events.some((e) => e.type === "context")).toBe(true);
    hub.memory.append({ kind: "talk", text: "SSE_ONE " + "x".repeat(120) });
    hub.memory.append({ kind: "talk", text: "SSE_TWO " + "x".repeat(120) });
    await waitUntil(() => events.some((e) => e.type === "context" && e.rows.some((r) => r.n >= 2)), 3000);
    await reader.cancel().catch(() => undefined);
    await pump.catch(() => undefined);
    const ctx = events.filter((e): e is ContextSnapshot => e.type === "context");
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx[0]?.session).toBe("main");
    expect(hub.snapshot().context.session).toBe("main");
  } finally {
    booted.stop();
  }
});

function assembleUnchanged(lines: string[]): boolean {
  return lines.every((line) => /^\d+\+\d+\|/.test(line));
}
