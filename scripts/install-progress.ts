#!/usr/bin/env bun
import { writeSync } from "node:fs";

const phase = process.argv[2] ?? "install";
if (phase === "done") writeSync(2, "NCLI: instalado.\n");
else writeSync(2, "NCLI: instalando dependências...\n");
