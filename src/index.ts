#!/usr/bin/env bun
import { bootNcli, bootVerbose, formatBoot } from "./boot";
import { flushText } from "./boot-ready";
import { bunxExtractRoot, planBunxRefresh } from "./bunx-cache";
import { fetchMainTip } from "./revision";
import { registerBootShutdown } from "./boot-shutdown";
import { installChildShutdown, superviseChild } from "./shutdown";
import { loadNcliSecrets } from "./secrets";

loadNcliSecrets();
const uid = process.getuid?.() ?? 0;
const runningPath = import.meta.path;
const refresh = planBunxRefresh({
  runningPath,
  env: process.env,
  uid,
  remoteSha: bunxExtractRoot(runningPath, uid) ? await fetchMainTip() : undefined,
});
if (refresh.kind === "reexec") {
  process.exit(await superviseChild(refresh.argv, { ...process.env, ...refresh.env }));
}
const stopWatch = installChildShutdown();
let booted;
try {
  booted = await bootNcli({ openBrowser: true });
} catch (err) {
  stopWatch();
  throw err;
}
registerBootShutdown(booted);
if (bootVerbose()) flushText(formatBoot(booted.report, { verbose: true }));
