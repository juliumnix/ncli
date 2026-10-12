#!/usr/bin/env bun
import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseRevision, parseShaFromPath, readGitHead } from "../src/revision";

const phase = process.argv[2] ?? "install";
if (phase === "done") {
  const root = join(import.meta.dir, "..");
  const rev = parseRevision(readGitHead(root)) ?? parseRevision(parseShaFromPath(import.meta.dir));
  if (rev) writeFileSync(join(root, ".ncli-revision"), `${rev.sha}\n`);
  writeSync(2, "NCLI: instalado.\n");
} else writeSync(2, "NCLI: instalando dependências...\n");
