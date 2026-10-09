import { bootNcli, formatBoot } from "./boot";

const booted = await bootNcli();
console.log(formatBoot(booted.report));
