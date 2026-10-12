import { expect, test } from "bun:test";
import { generateTranscript } from "../eval/memory/generator";
import { runMemoryEval } from "../eval/memory/run";
import { tmpDir } from "./helpers";

test("the seeded transcript plants five needle kinds at stable indexes", () => {
  const t = generateTranscript(1, 300);
  expect(t.needles.map((n) => n.id)).toEqual(["simple", "superseded", "space", "echo", "sibling"]);
  expect(t.lines[t.needles[0].messageIndex].text).toContain("FACT_ALPHA_ID_88421");
  expect(t.lines.some((l) => l.text.includes("RATE_NOW=7"))).toBe(true);
  expect(t.lines.some((l) => l.text.includes("OTHER_SPACE_TOKEN"))).toBe(true);
  expect(t.lines.some((l) => l.text.includes("BUG_SIBLING_FIXED"))).toBe(true);
  expect(t.needles.find((n) => n.id === "echo")?.inEcho).toBe(true);
});

test("memory:eval on 300 mock messages reports each needle", async () => {
  const report = await runMemoryEval({
    n: 300,
    seed: 1,
    viewBytes: 2500,
    nodeBytes: 280,
    dir: tmpDir("memory-eval"),
    label: "mock",
  });
  expect(report.settled).toBe(true);
  expect(report.needles).toHaveLength(5);
  const echo = report.needles.find((n) => n.id === "echo");
  expect(echo?.inLog).toBe(false);
  const simple = report.needles.find((n) => n.id === "simple");
  expect(simple?.inLog).toBe(true);
  expect(simple?.reachedLeaf).toBe(true);
  expect(report.reachability).toBeGreaterThan(0);
  expect(typeof report.viewPresence).toBe("number");
});
