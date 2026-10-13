#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRevision } from "../src/revision";

const phase = process.argv[2] ?? "install";
if (phase === "done") {
  const root = join(import.meta.dir, "..");
  const rev = resolveRevision(root, process.env, [import.meta.path, process.cwd()]);
  if (rev.sha !== "unknown") writeFileSync(join(root, ".ncli-revision"), `${rev.sha}\n`);
  process.stderr.write("NCLI: instalado.\n");
} else process.stderr.write("NCLI: instalando dependências...\n");
