#!/usr/bin/env bun
import { bootNcli, bootVerbose, formatBoot } from "./boot";
import { flushText } from "./boot-ready";
import { loadNcliSecrets } from "./secrets";

loadNcliSecrets();
const booted = await bootNcli({ openBrowser: true });
if (bootVerbose()) flushText(formatBoot(booted.report, { verbose: true }));
