import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { formatEvalTable, runMemoryEval, writeEvalReport } from "../eval/memory/run";

const n = Number(process.env.MEMORY_EVAL_N ?? 300);
const seed = Number(process.env.MEMORY_EVAL_SEED ?? 1);
const viewBytes = Number(process.env.NCLI_VIEW ?? 2500);
const nodeBytes = Number(process.env.NCLI_NODE ?? 280);
const outDir = process.env.MEMORY_EVAL_OUT ?? join(import.meta.dir, "../eval/memory/results");
const label = process.env.MEMORY_EVAL_LABEL ?? "mock";

const report = await runMemoryEval({
  n,
  seed,
  viewBytes,
  nodeBytes,
  dir: mkdtempSync(join(tmpdir(), "ncli-memory-eval-")),
  label,
});

const stamp = report.at.replace(/[:.]/g, "-").slice(0, 19);
const path = writeEvalReport(report, outDir, `memory-${label}-${stamp}.json`);
console.log(formatEvalTable(report));
console.log(`wrote ${path}`);

const minRecall = Number(process.env.MEMORY_EVAL_MIN_RECALL ?? "");
if (Number.isFinite(minRecall) && report.viewPresence < minRecall) {
  process.exit(2);
}
const maxInvented = Number(process.env.MEMORY_EVAL_MAX_INVENTED ?? "");
if (Number.isFinite(maxInvented) && report.invented > maxInvented) {
  process.exit(3);
}
