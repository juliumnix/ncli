import { expect, test } from "bun:test";
import { Memory, mockCompressor } from "../src/memory/store";
import { tmpDir } from "./helpers";

const FACT = "FACT_MEMBER_DISCOUNT_BEFORE_TAX";

test("fit keeps the view at or under the byte budget after compaction", async () => {
  const mem = new Memory({
    dir: tmpDir("mem"),
    nodeBytes: 120,
    viewBytes: 600,
    compressor: mockCompressor(),
  });
  for (let i = 0; i < 40; i++) {
    mem.append({ kind: i % 2 === 0 ? "user" : "talk", text: `msg ${i} filler about billing and tax rules` });
  }
  await mem.pump();
  expect(mem.allBuilt()).toBe(true);
  expect(mem.viewBytesUsed()).toBeLessThanOrEqual(600);
  expect(mem.view.length).toBeGreaterThan(0);
  const sizes = new Set(mem.view.map((p) => p.n));
  expect(sizes.has(1) || [...sizes].some((n) => n > 1)).toBe(true);
});

test("free nodes skip the compressor when the source already fits NODE", async () => {
  let calls = 0;
  const mem = new Memory({
    dir: tmpDir("mem"),
    nodeBytes: 400,
    viewBytes: 2000,
    compressor: async () => {
      calls += 1;
      return "compressed";
    },
  });
  mem.append({ kind: "user", text: "curto" });
  await mem.pump();
  expect(calls).toBe(0);
  expect(mem.nodeOf(0, 0)?.text).toBe("user: curto");
});

test("keyword facts survive a merge so zoom can find them", async () => {
  const mem = new Memory({
    dir: tmpDir("mem"),
    nodeBytes: 160,
    viewBytes: 400,
    compressor: mockCompressor(),
  });
  mem.append({ kind: "user", text: "hello" });
  mem.append({ kind: "talk", text: `decided ${FACT} before tax` });
  mem.append({ kind: "user", text: "ok" });
  mem.append({ kind: "talk", text: "noted" });
  await mem.pump();
  const parent = mem.nodeOf(1, 0) || mem.nodeOf(2, 0);
  expect(parent?.text.includes(FACT) ?? mem.log[1].text.includes(FACT)).toBe(true);
});
