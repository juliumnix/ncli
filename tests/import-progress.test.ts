import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatImportChip, Importer, importPct } from "../src/import";
import { makeHub, tmpDir } from "./helpers";

test("importPct is processed over total and unknown before the first count", () => {
  expect(importPct(0, 0)).toBeNull();
  expect(importPct(0, 8)).toBe(0);
  expect(importPct(3, 8)).toBe(37);
  expect(importPct(8, 8)).toBe(100);
  expect(importPct(2, 0)).toBe(100);
});

test("formatImportChip names the CLI then the live percent", () => {
  expect(formatImportChip("claude")).toBe("trazer Claude");
  expect(formatImportChip("claude", { source: "claude", done: 0, total: 0 })).toBe("trazendo…");
  expect(formatImportChip("codex", { source: "codex", done: 21, total: 50 })).toBe("trazendo… 42%");
});

test("apply reports done/total on each line", async () => {
  const ticks: Array<{ done: number; total: number }> = [];
  const dir = tmpDir("imp-prog");
  const importer = new Importer(dir, {
    claude: join(import.meta.dir, "../fixtures/import/claude/projects"),
    codex: tmpDir("empty-codex"),
    cursor: tmpDir("empty-cursor"),
  });
  await importer.apply("claude", undefined, () => undefined, () => false, (p) => ticks.push({ done: p.done, total: p.total }));
  expect(ticks[0]).toEqual({ done: 0, total: 4 });
  expect(ticks.at(-1)).toEqual({ done: 4, total: 4 });
  expect(ticks.map((t) => t.done)).toEqual([0, 1, 2, 3, 4]);
});

test("hub apply emits import-progress from the backend count", async () => {
  const { hub } = await makeHub({ importClaude: join(import.meta.dir, "../fixtures/import/claude/projects") });
  const ticks: Array<{ done: number; total: number; pct: number | null }> = [];
  try {
    hub.subscribe((ev) => {
      if (ev.type === "import-progress") ticks.push({ done: ev.done, total: ev.total, pct: ev.pct });
    });
    await hub.applyImport("claude", undefined, { surface: true });
    expect(ticks[0]).toEqual({ done: 0, total: 4, pct: 0 });
    expect(ticks.at(-1)).toEqual({ done: 4, total: 4, pct: 100 });
    expect(ticks.some((t) => t.pct === 50)).toBe(true);
  } finally {
    hub.close();
  }
});

test("a fat project root still reports percent against the line total", async () => {
  const root = tmpDir("fat-claude");
  const proj = join(root, "workspace");
  mkdirSync(proj, { recursive: true });
  const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({
    type: "user",
    timestamp: `2026-10-12T00:00:${String(i).padStart(2, "0")}.000Z`,
    cwd: "/workspace",
    message: { content: `FACT_LINE_${i}` },
  }));
  writeFileSync(join(proj, "sess.jsonl"), `${lines.join("\n")}\n`);
  const ticks: number[] = [];
  const { hub } = await makeHub({ importClaude: root });
  try {
    hub.subscribe((ev) => {
      if (ev.type === "import-progress" && ev.pct !== null) ticks.push(ev.pct);
    });
    await hub.applyImport("claude", undefined, { surface: true });
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(100);
    expect(ticks.some((p) => p > 0 && p < 100)).toBe(true);
  } finally {
    hub.close();
  }
});
