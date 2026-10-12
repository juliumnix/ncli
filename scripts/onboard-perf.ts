import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runOnboard } from "../src/perf/onboard";
import { formatMs } from "../src/perf/stats";

const runs = Number(process.env.NCLI_ONBOARD_RUNS || 5);
const chrome = process.env.NCLI_PERF_CHROME === "0" ? false : undefined;
const screenshotDir = process.env.NCLI_ONBOARD_SHOTS || join(process.cwd(), "artifacts", "onboard");

const report = await runOnboard({
  runs: Number.isFinite(runs) && runs > 0 ? runs : 5,
  chrome,
  screenshotDir,
  fatFiles: Number(process.env.NCLI_ONBOARD_FAT || 400),
});

mkdirSync(screenshotDir, { recursive: true });
const jsonPath = join(screenshotDir, "report.json");
writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

const rows = [
  "metric                  n  err     p50     p95     min     max   work",
  "---------------------- --  ---  ------  ------  ------  ------  ----",
];
for (const s of report.metrics) {
  rows.push(
    `${s.metric.padEnd(22)} ${String(s.n).padStart(2)}  ${String(s.errors).padStart(3)}  ${formatMs(s.p50).padStart(6)}  ${formatMs(s.p95).padStart(6)}  ${formatMs(s.min).padStart(6)}  ${formatMs(s.max).padStart(6)}  ${String(s.work).padStart(4)}`,
  );
}

console.log(
  `NCLI onboard  runs=${report.runs}  cores=${report.cores}  load=${report.load}  chrome=${report.chrome}`,
);
console.log(rows.join("\n"));
console.log(`wrote ${jsonPath}`);
const errors = report.samples.filter((s) => !s.ok).length;
const work = report.samples.reduce((n, s) => n + s.work, 0);
console.log(`errors=${errors}  work=${work}`);
