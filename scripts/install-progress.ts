#!/usr/bin/env bun
const phase = process.argv[2] ?? "install";
if (phase === "done") process.stderr.write("NCLI: instalado.\n");
else process.stderr.write("NCLI: instalando dependências...\n");
