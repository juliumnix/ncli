import { expect, test } from "bun:test";
import { assemble } from "../src/memory/assemble";
import { Memory, mockCompressor } from "../src/memory/store";
import { tmpDir } from "./helpers";

test("the system prompt says the view's latest word is the truth", () => {
  const mem = new Memory({
    dir: tmpDir("supersede-prompt"),
    nodeBytes: 200,
    viewBytes: 2000,
    compressor: mockCompressor(),
  });
  mem.append({ kind: "user", text: "RATE=10" });
  expect(assemble(mem).system).toContain("latest word on a thing is the truth");
});

test("zoom of a superseded message names the replacement", async () => {
  const mem = new Memory({
    dir: tmpDir("supersede-zoom"),
    nodeBytes: 200,
    viewBytes: 2000,
    compressor: mockCompressor(),
  });
  mem.append({ kind: "user", text: "RATE=10" });
  mem.append({ kind: "note", text: "RATE=7", supersedes: [0], reason: "user corrected the rate" });
  await mem.settle();
  const leaf = mem.zoom(0, 1);
  expect(leaf.ok).toBe(true);
  if (leaf.ok) expect(leaf.lines[0]).toMatch(/SUPERSEDED by #1/);
});
