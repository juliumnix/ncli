#!/usr/bin/env bun
import { bootNcli, bootVerbose, formatBoot } from "./boot";
import { flushText } from "./boot-ready";
import { bunxNeedsRemoteTip, planBunxRefresh } from "./bunx-cache";
import { fetchMainTip } from "./revision";
import { loadNcliSecrets } from "./secrets";

loadNcliSecrets();
const uid = process.getuid?.() ?? 0;
const runningPath = import.meta.path;
const refresh = planBunxRefresh({
  runningPath,
  env: process.env,
  uid,
  remoteSha: bunxNeedsRemoteTip(runningPath, process.env, uid) ? fetchMainTip() : undefined,
});
if (refresh.kind === "reexec") {
  const child = Bun.spawn(refresh.argv, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...refresh.env },
  });
  process.exit((await child.exited) ?? 1);
}
const booted = await bootNcli({ openBrowser: true });
if (bootVerbose()) flushText(formatBoot(booted.report, { verbose: true }));
