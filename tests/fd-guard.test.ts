import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultImportRoots, runImportJob } from "../src/import";
import { Memory, mockCompressor } from "../src/memory/store";
import { tmpDir } from "./helpers";

function writeTinyClaude(root: string, files = 2, lines = 8): void {
  const proj = join(root, "workspace");
  mkdirSync(proj, { recursive: true });
  for (let f = 0; f < files; f++) {
    const rows = Array.from({ length: lines }, (_, i) => JSON.stringify({
      type: i % 2 === 0 ? "user" : "assistant",
      timestamp: `2026-10-13T00:00:${String(i).padStart(2, "0")}.000Z`,
      cwd: "/workspace",
      message: { content: `line-${f}-${i}` },
    }));
    writeFileSync(join(proj, `sess-${f}.jsonl`), `${rows.join("\n")}\n`);
  }
}

async function scanProcPids(): Promise<string[]> {
  const proc = Bun.spawn(["ps", "-eo", "pid=,args="], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("scan-proc"))
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter(Boolean);
}

test("import scan and jsonl append can loop without throwing", async () => {
  const root = tmpDir("fd-scan");
  writeTinyClaude(root);
  for (let i = 0; i < 12; i++) {
    const result = await runImportJob({
      source: "claude",
      roots: { ...defaultImportRoots(), claude: root },
      seenFile: join(tmpDir(`fd-seen-${i}`), "import-seen.json"),
      onBatch: () => undefined,
    });
    expect(result.applied).toBeGreaterThan(0);
  }
  expect(await scanProcPids()).toEqual([]);
  const mem = new Memory({
    dir: tmpDir("fd-mem"),
    nodeBytes: 80,
    viewBytes: 800,
    compressor: mockCompressor(),
  });
  mem.ingest(Array.from({ length: 200 }, (_, i) => ({ kind: "user" as const, text: `append ${i}` })), { quiet: true });
  mem.seed();
  expect(mem.T).toBe(200);
  mem.paused = true;
});

test("src import and memory paths do not Worker, spawn a scan child, openSync, or closeSync", () => {
  const files = [
    "src/import/job.ts",
    "src/import/scan.ts",
    "src/memory/store.ts",
    "src/memory/cursor-compact.ts",
    "src/memory/compact.ts",
    "src/boot.ts",
    "src/index.ts",
    "src/hub.ts",
  ].map((rel) => join(import.meta.dir, "..", rel));
  const joined = files.map((f) => readFileSync(f, "utf8")).join("\n");
  expect(joined).not.toMatch(/\bnew Worker\b/);
  expect(joined).not.toMatch(/\bopenSync\b/);
  expect(joined).not.toMatch(/\bcloseSync\b/);
  const job = readFileSync(join(import.meta.dir, "../src/import/job.ts"), "utf8");
  expect(job).not.toMatch(/\bBun\.spawn\b/);
  expect(job).toContain("runImportScan");
  const index = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
  expect(index.indexOf("planBunxRefresh({")).toBeGreaterThan(-1);
  expect(index.indexOf("planBunxRefresh({")).toBeLessThan(index.indexOf("await bootNcli"));
});

test("a large synthetic Claude history imports through the in-process scan", async () => {
  const root = tmpDir("fd-large");
  writeTinyClaude(root, 40, 40);
  const result = await runImportJob({
    source: "claude",
    roots: { ...defaultImportRoots(), claude: root },
    seenFile: join(tmpDir("fd-large-seen"), "import-seen.json"),
    onBatch: () => undefined,
  });
  expect(result.applied).toBe(40 * 40);
  expect(await scanProcPids()).toEqual([]);
});
