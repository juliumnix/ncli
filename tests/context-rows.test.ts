import { expect, test } from "bun:test";
import { assemble } from "../src/memory/assemble";
import { badgeTone, contextRows, diffContext, partsCover, relativeTime } from "../src/memory/context";
import { Memory } from "../src/memory/store";
import { tmpDir } from "./helpers";

function mem(dir: string, viewBytes = 4000, nodeBytes = 80): Memory {
  return new Memory({
    dir: tmpDir(dir),
    nodeBytes,
    viewBytes,
    compressor: async (input) => input.source.slice(0, 40),
  });
}

test("contextRows tiles [0, T) with power-of-two n and no duplicate prefix", () => {
  const m = mem("ctx-cover");
  m.append({ kind: "talk", text: "MCP ncli sem conexão, ask/wait indisponíveis" });
  m.append({ kind: "user", text: "volta?" });
  const rows = contextRows(m);
  expect(partsCover(rows, m.T)).toBe(true);
  expect(rows[0]?.id).toBe("0+1");
  expect(rows[0]?.n).toBe(1);
  expect(rows[0]?.text).toBe("talk: MCP ncli sem conexão, ask/wait indisponíveis");
  expect(rows[0]?.text).not.toContain("0+1|");
  expect(rows[1]?.kind).toBe("user");
});

test("assemble view stays id+n|text after context projection", () => {
  const m = mem("ctx-assemble");
  m.append({ kind: "talk", text: "MCP ncli sem conexão" });
  const ctx = assemble(m);
  expect(ctx.view).toContain("0+1|talk: MCP ncli sem conexão");
  expect(contextRows(m)[0]?.id).toBe("0+1");
});

test("diffContext of two 1x plus a built parent is one merge", async () => {
  const m = mem("ctx-merge", 60, 40);
  m.append({ kind: "talk", text: "ALPHA_NODE long enough to force a leaf " + "x".repeat(80) });
  m.append({ kind: "talk", text: "BETA_NODE long enough to force a leaf " + "x".repeat(80) });
  const before = contextRows(m);
  expect(before.map((r) => r.id)).toEqual(["0+1", "1+1"]);
  await m.pump();
  const after = contextRows(m);
  expect(partsCover(after, m.T)).toBe(true);
  const ops = diffContext(before, after);
  const merge = ops.find((o) => o.op === "merge");
  if (after.some((r) => r.n >= 2)) {
    expect(merge).toEqual({ op: "merge", from: ["0+1", "1+1"], into: "0+2" });
    expect(ops.filter((o) => o.op === "add")).toEqual([]);
  }
  expect(after.every((r) => r.built)).toBe(true);
});

test("badgeTone stays on the NCLI terracotta accent", () => {
  expect(badgeTone(1).toLowerCase()).toBe("#3d3330");
  expect(badgeTone(1).toLowerCase()).not.toBe("#28a745");
  expect(badgeTone(64).toLowerCase()).toBe("#c2603d");
  expect(badgeTone(256)).toMatch(/^#[0-9a-f]{6}$/i);
  expect(badgeTone(256)).not.toBe(badgeTone(1));
});

test("relativeTime speaks Portuguese", () => {
  const now = Date.parse("2026-10-09T20:00:00.000Z");
  expect(relativeTime("2026-10-09T19:59:55.000Z", now)).toBe("agora");
  expect(relativeTime("2026-10-09T19:58:00.000Z", now)).toBe("há 2 min");
  expect(relativeTime("2026-07-09T20:00:00.000Z", now)).toBe("~3 meses atrás");
});
