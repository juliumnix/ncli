import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isResumeOpen, loadCheckpoint } from "../src/import/checkpoint";
import { Memory, mockCompressor, type Compressor } from "../src/memory/store";
import { makeHub, tmpDir, waitUntil } from "./helpers";

function watchCompact(hub: { memory: { compressor: Compressor } }): () => number {
  let n = 0;
  const orig = hub.memory.compressor;
  hub.memory.compressor = async (input) => {
    n += 1;
    return orig(input);
  };
  return () => n;
}

function writeClaudeTree(root: string, files: number, lines: number, factAt = 0): number {
  const proj = join(root, "workspace");
  mkdirSync(proj, { recursive: true });
  let n = 0;
  for (let f = 0; f < files; f++) {
    const rows: string[] = [];
    for (let i = 0; i < lines; i++) {
      const text = n === factAt
        ? "FACT_MEMBER_DISCOUNT_BEFORE_TAX o desconto entra antes do imposto"
        : `ROW_${f}_${i}`;
      rows.push(JSON.stringify({
        type: i % 2 === 0 ? "user" : "assistant",
        timestamp: `2026-08-01T00:${String(f).padStart(2, "0")}:${String(i).padStart(2, "0")}.000Z`,
        cwd: "/workspace",
        message: { content: text },
      }));
      n += 1;
    }
    writeFileSync(join(proj, `sess-${String(f).padStart(3, "0")}.jsonl`), `${rows.join("\n")}\n`);
  }
  return n;
}

test("a killed import leaves a checkpoint and the next boot only finishes the rest", async () => {
  const root = tmpDir("resume-claude");
  const total = writeClaudeTree(root, 8, 40);
  const dataDir = tmpDir("resume-data");
  const first = await makeHub({ importClaude: root, dataDir });
  const firstCompact = watchCompact(first.hub);
  void first.hub.applyImport("claude", undefined, { surface: true });
  await waitUntil(() => first.hub.memory.T >= 64 && isResumeOpen(loadCheckpoint(dataDir)), 8000, "first lots");
  const midT = first.hub.memory.T;
  const compactBeforeKill = firstCompact();
  first.hub.close();
  expect(isResumeOpen(loadCheckpoint(dataDir))).toBe(true);
  expect(midT).toBeLessThan(total);

  const second = await makeHub({ importClaude: root, dataDir });
  const secondCompact = watchCompact(second.hub);
  try {
    await waitUntil(() => second.hub.memory.T >= total && loadCheckpoint(dataDir) === null, 15000, "resume finished");
    expect(loadCheckpoint(dataDir)).toBeNull();
    expect(second.hub.memory.log.some((m) => m.text.includes("FACT_MEMBER"))).toBe(true);
    expect(second.hub.memory.log.some((m) => m.text.includes("ROW_7_"))).toBe(true);
    expect(second.hub.memory.T).toBeGreaterThanOrEqual(total);
    console.log(`import-resume-kill mid=${midT} total=${total} after=${second.hub.memory.T} compact_before=${compactBeforeKill} compact_after=${secondCompact()}`);
  } finally {
    second.hub.close();
  }
});

test("a finished import does not apply the same lines again", async () => {
  const root = tmpDir("resume-skip");
  writeClaudeTree(root, 6, 20);
  const dataDir = tmpDir("resume-skip-data");
  const { hub } = await makeHub({ importClaude: root, dataDir });
  const result = await hub.applyImport("claude", undefined, { surface: true });
  expect(result.applied).toBeGreaterThan(0);
  expect(result.filesSkipped ?? 0).toBe(0);
  hub.close();

  const again = await makeHub({ importClaude: root, dataDir });
  try {
    const second = await again.hub.applyImport("claude", undefined, { surface: true });
    expect(second.applied).toBe(0);
    expect((second.filesSkipped ?? 0) + (second.preview.seenCount)).toBeGreaterThan(0);
  } finally {
    again.hub.close();
  }
});

test("a reloaded tree does not call the compressor for nodes it already built", async () => {
  const dir = tmpDir("compact-resume");
  const firstCalls: string[] = [];
  const mem = new Memory({
    dir,
    nodeBytes: 80,
    viewBytes: 200,
    compressor: async (input) => {
      firstCalls.push(`${input.kind}:${input.source.slice(0, 24)}`);
      return mockCompressor()(input);
    },
  });
  for (let i = 0; i < 40; i++) {
    mem.append({ kind: i % 2 === 0 ? "user" : "talk", text: `FACT_LINE_${i} filler about billing tax member discount` });
  }
  await mem.pump();
  expect(firstCalls.length).toBeGreaterThan(0);
  const built = [...mem.nodes.keys()].sort();

  const replay: string[] = [];
  const mem2 = new Memory({
    dir,
    nodeBytes: 80,
    viewBytes: 200,
    compressor: async (input) => {
      replay.push(`${input.kind}:${input.source.slice(0, 24)}`);
      return mockCompressor()(input);
    },
  });
  await mem2.pump();
  expect(replay).toEqual([]);
  expect([...mem2.nodes.keys()].sort()).toEqual(built);
  console.log(`resume-compact before=${firstCalls.length} after=${replay.length}`);
});
