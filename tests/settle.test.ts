import { expect, test } from "bun:test";
import { assemble } from "../src/memory/assemble";
import { Memory } from "../src/memory/store";
import { makeHub, tmpDir } from "./helpers";

const PLACEHOLDER = "(not summarized yet: zoom it)";

test("settle waits until every cover line is built and shows no raw excerpt", async () => {
  const mem = new Memory({
    dir: tmpDir("settle"),
    nodeBytes: 40,
    viewBytes: 8000,
    compressor: async (input) => {
      await Bun.sleep(30);
      return input.source.slice(0, 36);
    },
  });
  for (let i = 0; i < 4; i++) {
    mem.append({ kind: "user", text: `long pending user line ${i} ${"x".repeat(80)}` });
  }
  expect(mem.allBuilt()).toBe(false);
  const ok = await mem.settle(5_000);
  expect(ok).toBe(true);
  expect(mem.allBuilt()).toBe(true);
  expect(mem.viewLines().join("\n")).not.toMatch(/user: .{50,}/);
});

test("a settle timeout paints the recipe placeholder, never a raw excerpt", async () => {
  const mem = new Memory({
    dir: tmpDir("settle-timeout"),
    nodeBytes: 40,
    viewBytes: 8000,
    compressor: async () => new Promise(() => undefined),
  });
  mem.append({ kind: "user", text: `pending raw ${"y".repeat(80)}` });
  const ok = await mem.settle(80);
  expect(ok).toBe(false);
  expect(mem.allBuilt()).toBe(false);
  expect(mem.viewLines()).toEqual([`0+1|${PLACEHOLDER}`]);
  expect(assemble(mem).system).toContain(PLACEHOLDER);
  expect(assemble(mem).system).not.toContain("short raw excerpt");
});

test("the turn prompt is view, then inbox, then the user line", async () => {
  const { hub, harness } = await makeHub();
  try {
    hub.bus.post("codex", "main", "INBOX_SECRET_LINE");
    await hub.send("pergunta do usuario");
    const prompt = harness.lastPrompts.at(-1) ?? "";
    expect(prompt).toContain("<chat>");
    expect(prompt).toContain("INBOX_SECRET_LINE");
    expect(prompt).toContain("pergunta do usuario");
    expect(prompt.indexOf("<chat>")).toBeLessThan(prompt.indexOf("INBOX_SECRET_LINE"));
    expect(prompt.indexOf("INBOX_SECRET_LINE")).toBeLessThan(prompt.indexOf("pergunta do usuario"));
  } finally {
    hub.close();
  }
});
