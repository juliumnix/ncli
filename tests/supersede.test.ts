import { expect, test } from "bun:test";
import { assemble } from "../src/memory/assemble";
import { Memory, mockCompressor } from "../src/memory/store";
import { makeHub, tmpDir } from "./helpers";

test("zoom of a replaced message names the successor and keeps the original text", async () => {
  const dir = tmpDir("super-zoom");
  const mem = new Memory({
    dir,
    nodeBytes: 80,
    viewBytes: 2000,
    compressor: mockCompressor(),
  });
  const old = mem.append({ kind: "user", text: "member discount is 10 percent" });
  const neu = mem.append({ kind: "user", text: "member discount is 15 percent" });
  mem.append({
    kind: "note",
    text: `supersedes #${old.i} → #${neu.i}: user corrected the rate`,
    supersedes: [old.i],
    successor: neu.i,
    reason: "user corrected the rate",
  });
  const zoom = mem.zoom(old.i, 1);
  expect(zoom.ok).toBe(true);
  if (!zoom.ok) return;
  expect(zoom.lines[0]).toBe(`SUPERSEDED by #${neu.i} (user corrected the rate)`);
  expect(zoom.lines[1]).toBe(`${old.i}+0|user: member discount is 10 percent`);
  expect(mem.log[old.i]?.text).toBe("member discount is 10 percent");
  expect(mem.log[old.i]?.supersedes).toBeUndefined();

  const reloaded = new Memory({
    dir,
    nodeBytes: 80,
    viewBytes: 2000,
    compressor: mockCompressor(),
  });
  const again = reloaded.zoom(old.i, 1);
  expect(again.ok).toBe(true);
  if (!again.ok) return;
  expect(again.lines[0]).toBe(`SUPERSEDED by #${neu.i} (user corrected the rate)`);
  expect(again.lines[1]).toBe(`${old.i}+0|user: member discount is 10 percent`);
});

test("a chain of replacements reports the latest successor", () => {
  const mem = new Memory({
    dir: tmpDir("super-chain"),
    nodeBytes: 80,
    viewBytes: 2000,
    compressor: mockCompressor(),
  });
  const a = mem.append({ kind: "user", text: "rate is 10" });
  const b = mem.append({ kind: "user", text: "rate is 12" });
  mem.append({
    kind: "note",
    text: `supersedes #${a.i} → #${b.i}: first correction`,
    supersedes: [a.i],
    successor: b.i,
    reason: "first correction",
  });
  const c = mem.append({ kind: "user", text: "rate is 15" });
  mem.append({
    kind: "note",
    text: `supersedes #${b.i} → #${c.i}: second correction`,
    supersedes: [b.i],
    successor: c.i,
    reason: "second correction",
  });
  const zoom = mem.zoom(a.i, 1);
  expect(zoom.ok).toBe(true);
  if (!zoom.ok) return;
  expect(zoom.lines[0]).toBe(`SUPERSEDED by #${c.i} (second correction)`);
});

test("supersede MCP writes a note and zoom follows it after reload", async () => {
  const { hub, dataDir } = await makeHub();
  try {
    const old = hub.memory.append({ kind: "user", text: "ship Friday" });
    const neu = hub.memory.append({ kind: "user", text: "ship Monday" });
    const out = await hub.callMcp("supersede", {
      old: old.i,
      new: neu.i,
      reason: "user moved the ship date",
    }, "main");
    expect(out).toMatch(/^ok #\d+$/);
    const zoom = await hub.callMcp("zoom", { id: old.i, n: 1 }, "main");
    expect(zoom).toBe(
      `SUPERSEDED by #${neu.i} (user moved the ship date)\n${old.i}+0|user: ship Friday`,
    );
    const fresh = new Memory({
      dir: `${dataDir}/main`,
      nodeBytes: 140,
      viewBytes: 800,
      compressor: mockCompressor(),
    });
    const again = fresh.zoom(old.i, 1);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.lines[0]).toBe(`SUPERSEDED by #${neu.i} (user moved the ship date)`);
    expect(assemble(hub.memory).view).toContain("ship Friday");
    expect(assemble(hub.memory).view).toContain("ship Monday");
  } finally {
    hub.close();
  }
});
