import { expect, test } from "bun:test";
import { Memory, mockCompressor } from "../src/memory/store";
import { assemble, partsCover } from "../src/memory/assemble";
import { tmpDir } from "./helpers";

test("assembled view tiles [0, T) without gaps and never shows a whole raw message in the cover lines", async () => {
  const mem = new Memory({
    dir: tmpDir("ctx"),
    nodeBytes: 100,
    viewBytes: 500,
    compressor: mockCompressor(),
  });
  for (let i = 0; i < 24; i++) {
    mem.append({
      kind: i % 2 === 0 ? "user" : "talk",
      text: `UNIQUE_PAYLOAD_${i}_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    });
  }
  await mem.pump();
  expect(partsCover(mem.view)).toBe(true);
  const last = mem.view.at(-1);
  expect(last?.start).toBeDefined();
  expect((last!.start + last!.n)).toBe(mem.T);
  const ctx = assemble(mem);
  expect(ctx.system).toContain("ncli/skills/add-view/SKILL.md");
  expect(ctx.view.startsWith("<chat>")).toBe(true);
  expect(ctx.allBuilt).toBe(true);
  expect(ctx.bytes).toBeLessThanOrEqual(500);
  expect(ctx.T).toBe(24);
  const raw = "UNIQUE_PAYLOAD_0_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const onlyAsSummary = ctx.lines.every((line) => !line.includes(`user: ${raw}`) || line.startsWith("0+"));
  expect(onlyAsSummary).toBe(true);
});

test("zoom(id, n) opens a parent into two children, and n=1 returns the raw message", async () => {
  const mem = new Memory({
    dir: tmpDir("ctx"),
    nodeBytes: 80,
    viewBytes: 300,
    compressor: mockCompressor(),
  });
  for (let i = 0; i < 8; i++) mem.append({ kind: "note", text: `n${i}` });
  await mem.pump();
  const leaf = mem.zoom(3, 1);
  expect(leaf.ok).toBe(true);
  if (leaf.ok) expect(leaf.lines[0]).toContain("n3");
  const pair = mem.zoom(0, 2);
  expect(pair.ok).toBe(true);
  if (pair.ok) expect(pair.lines.length).toBe(2);
});
