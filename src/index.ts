#!/usr/bin/env bun
import { bootNcli, formatBoot } from "./boot";
import { flushText } from "./boot-ready";
import { loadNcliSecrets } from "./secrets";

loadNcliSecrets();
const booted = await bootNcli({ openBrowser: true });
flushText(formatBoot(booted.report));
