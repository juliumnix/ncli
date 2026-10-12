import { expect, test } from "bun:test";
import { assemble } from "../src/memory/assemble";
import { spaceFor } from "../src/memory/spaces";
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
  expect(mem.recall("member discount is 10").join("\n")).toContain(
    `SUPERSEDED by #${neu.i} (user corrected the rate)`,
  );
  expect(mem.renderView()).toContain(`SUPERSEDED by #${neu.i} (user corrected the rate)`);
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
    await hub.memory.settle();
    const view = assemble(hub.memory).view;
    expect(view).toContain("ship Friday");
    expect(view).toContain("ship Monday");
    expect(view).toContain(`SUPERSEDED by #${neu.i} (user moved the ship date)`);
    const recall = await hub.callMcp("recall", { pattern: "ship Friday" }, "main");
    expect(recall).toContain(`SUPERSEDED by #${neu.i} (user moved the ship date)`);
    expect(recall).toContain("ship Friday");
  } finally {
    hub.close();
  }
});

test("supersede rejects new<=old and cycles", async () => {
  const { hub } = await makeHub();
  try {
    const a = hub.memory.append({ kind: "user", text: "rate is 10" });
    const b = hub.memory.append({ kind: "user", text: "rate is 12" });
    const back = await hub.callMcp("supersede", { old: b.i, new: a.i, reason: "backwards" }, "main");
    expect(back).toBe("successor must be after the replaced message.");
    const same = await hub.callMcp("supersede", { old: a.i, new: a.i, reason: "self" }, "main");
    expect(same).toBe("successor must be after the replaced message.");
    const ok = await hub.callMcp("supersede", { old: a.i, new: b.i, reason: "first" }, "main");
    expect(ok).toMatch(/^ok #\d+$/);
    const backToOld = await hub.callMcp("supersede", { old: b.i, new: a.i, reason: "loop" }, "main");
    expect(backToOld).toBe("successor must be after the replaced message.");
    const c = hub.memory.append({ kind: "user", text: "rate is 15" });
    hub.memory.append({
      kind: "note",
      text: `supersedes #${c.i} → #${a.i}: raw back`,
      supersedes: [c.i],
      successor: a.i,
      reason: "raw back",
    });
    const loop = await hub.callMcp("supersede", { old: a.i, new: c.i, reason: "close the loop" }, "main");
    expect(loop).toBe("supersede cycle.");
  } finally {
    hub.close();
  }
});

test("supersede stays on the current space even when space names another project", async () => {
  const other = tmpDir("super-other");
  const { hub } = await makeHub();
  try {
    hub.memory.append({ kind: "user", text: "CURRENT_OLD" });
    hub.memory.append({ kind: "user", text: "CURRENT_NEW" });
    const foreign = hub.spaces.of(spaceFor(other));
    foreign.append({ kind: "user", text: "OTHER_OLD" });
    foreign.append({ kind: "user", text: "OTHER_NEW" });
    const out = await hub.callMcp("supersede", {
      old: 0,
      new: 1,
      reason: "cross space",
      space: spaceFor(other),
    }, "main");
    expect(out).toMatch(/^ok #\d+$/);
    const currentZoom = await hub.callMcp("zoom", { id: 0, n: 1 }, "main");
    expect(currentZoom).toContain("SUPERSEDED by #1 (cross space)");
    const otherZoom = foreign.zoom(0, 1);
    expect(otherZoom.ok).toBe(true);
    if (otherZoom.ok) expect(otherZoom.lines.join("\n")).not.toContain("SUPERSEDED");
    expect(foreign.recall("OTHER_OLD").join("\n")).not.toContain("SUPERSEDED");
  } finally {
    hub.close();
  }
});
