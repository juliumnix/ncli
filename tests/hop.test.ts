import { expect, test } from "bun:test";
import { Memory, mockCompressor } from "../src/memory/store";
import { tmpDir } from "./helpers";

const FACT = "FACT_MEMBER_DISCOUNT_BEFORE_TAX";

test("after 300 messages, hops from the cover recover the fact in message #12", async () => {
  const mem = new Memory({
    dir: tmpDir("hop"),
    nodeBytes: 140,
    viewBytes: 900,
    compressor: mockCompressor(),
  });
  for (let i = 0; i < 300; i++) {
    const text = i === 12
      ? `we decided ${FACT} discount before tax member only`
      : `synthetic filler line ${i} about meetings repos and chores`;
    mem.append({ kind: i % 3 === 0 ? "user" : "talk", text });
  }
  await mem.pump();
  expect(mem.T).toBe(300);
  expect(mem.allBuilt()).toBe(true);
  const cover = mem.view.find((p) => p.start <= 12 && 12 < p.start + p.n);
  expect(cover).toBeDefined();
  expect(cover!.n).toBeGreaterThan(1);

  const hops: string[] = [];
  let start = cover!.start;
  let n = cover!.n;
  while (n > 1) {
    const r = mem.zoom(start, n);
    expect(r.ok).toBe(true);
    if (r.ok) hops.push(r.lines.join(" || "));
    const mid = start + n / 2;
    if (12 >= mid) start = mid;
    n = n / 2;
  }
  const leaf = mem.zoom(12, 1);
  expect(leaf.ok).toBe(true);
  if (leaf.ok) {
    expect(leaf.lines[0]).toContain(FACT);
    hops.push(leaf.lines[0]);
  }
  expect(hops.length).toBeGreaterThan(2);
  expect(mem.log[12].text).toContain(FACT);
});
