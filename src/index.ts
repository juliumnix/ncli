import { bootNcli, formatBoot } from "./boot";
import { loadNcliSecrets } from "./secrets";

loadNcliSecrets();
const booted = await bootNcli();
console.log(formatBoot(booted.report));
