import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { documentRealHarness, runPerf } from "../src/perf/run";
import { formatTable } from "../src/perf/stats";

const runs = Number(process.env.NCLI_PERF_RUNS || 7);
const chrome = process.env.NCLI_PERF_CHROME === "0" ? false : undefined;
const screenshotDir = process.env.NCLI_PERF_SHOTS || join(process.cwd(), "artifacts", "perf");

const report = await runPerf({
  runs: Number.isFinite(runs) && runs > 0 ? runs : 7,
  harness: process.env.NCLI_HARNESS || "mock",
  chrome,
  screenshotDir,
});

mkdirSync(screenshotDir, { recursive: true });
const jsonPath = join(screenshotDir, "report.json");
writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

console.log(`NCLI perf  runs=${report.runs}  harness=${report.harness}  cores=${report.env.cores}  load=${report.env.load}  chrome=${report.env.chrome}`);
console.log(formatTable(report.metrics));
console.log(`wrote ${jsonPath}`);
console.log("");
console.log(documentRealHarness());
