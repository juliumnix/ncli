import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  measureBunxReady,
  measureHubStart,
  measureImportPreview,
  measureOnboardChrome,
  summarizeOnboard,
  writeFatClaude,
} from "../src/perf/onboard";
import { chromePath } from "../src/perf/cdp";

test("writeFatClaude writes one jsonl per session", () => {
  const root = join(tmpdir(), `ncli-fat-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  expect(writeFatClaude(root, 3, 2)).toBe(6);
});

test("a fat Claude tree makes Importer.preview slower than an empty root", () => {
  const empty = measureImportPreview({});
  const fat = measureImportPreview({ fatFiles: 400 });
  expect(empty.ok).toBe(true);
  expect(fat.ok).toBe(true);
  expect(fat.work).toBe(400);
  expect(fat.ms).toBeGreaterThan(empty.ms);
  expect(fat.ms - empty.ms).toBeGreaterThan(10);
});

test("a fat Claude tree makes hub.start slower than empty roots", async () => {
  const empty = await measureHubStart({});
  const fat = await measureHubStart({ fatFiles: 400 });
  expect(empty.ok).toBe(true);
  expect(fat.ok).toBe(true);
  expect(fat.work).toBe(400);
  expect(fat.ms).toBeGreaterThan(empty.ms);
});

test("summarizeOnboard counts errors apart from work", () => {
  const s = summarizeOnboard("hub_start", [
    { metric: "hub_start", ms: 10, ok: true, work: 1 },
    { metric: "hub_start", ms: 30, ok: true, work: 1 },
    { metric: "hub_start", ms: 0, ok: false, work: 0 },
  ]);
  expect(s.n).toBe(3);
  expect(s.errors).toBe(1);
  expect(s.work).toBe(2);
  expect(s.p50).toBe(20);
});

test("bunx-equivalent spawn answers HTTP on an empty first session", async () => {
  const sample = await measureBunxReady({});
  expect(sample.ok).toBe(true);
  expect(sample.ms).toBeGreaterThan(0);
  expect(sample.ms).toBeLessThan(8000);
});

test("chrome: welcome → import → first reply → paste PR", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const samples = await measureOnboardChrome({});
  const by = Object.fromEntries(samples.map((s) => [s.metric, s]));
  expect(by.welcome_paint?.ok).toBe(true);
  expect(by.import_ready?.ok).toBe(true);
  expect(by.import_apply?.ok).toBe(true);
  expect(by.first_reply?.ok).toBe(true);
  expect(by.pr_open?.ok).toBe(true);
  expect(by.onboard_total?.ok).toBe(true);
  expect(by.onboard_total?.work).toBe(5);
}, 60000);
