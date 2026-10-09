#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEEP = [
  "animation-vocabulary",
  "apple-design",
  "emil-design-eng",
  "find-animation-opportunities",
  "improve-animations",
  "review-animations",
];

const root = process.env.NCLI_ROOT ?? process.cwd();
const dest = join(root, "ncli/skills/emil");
const src = process.env.EMIL_SRC ?? findLocal() ?? "";

if (!src || !existsSync(join(src, "skills", "emil-design-eng", "SKILL.md"))) {
  console.error("Set EMIL_SRC to an emilkowalski/skills checkout (needs skills/emil-design-eng + LICENSE).");
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const id of KEEP) {
  const from = join(src, "skills", id);
  if (!existsSync(join(from, "SKILL.md"))) {
    console.error(`missing skill ${id} under ${from}`);
    process.exit(1);
  }
  cpSync(from, join(dest, id), { recursive: true });
}
if (existsSync(join(src, "LICENSE"))) cpSync(join(src, "LICENSE"), join(dest, "LICENSE"));
writeFileSync(
  join(dest, "SOURCE.md"),
  `# Emil design skills (vendored)

- Upstream: https://github.com/emilkowalski/skills
- License: MIT — Emil Kowalski 2026. See LICENSE
- Synced from: ${src}
- Date: ${new Date().toISOString().slice(0, 10)}
- Keep: ${KEEP.join(", ")}
- Sync: bun run scripts/sync-emil.ts
`,
  "utf8",
);
console.log(`synced emil skills → ${dest} (${KEEP.length})`);

function findLocal(): string | undefined {
  const guesses = [
    "/tmp/emil-skills-src",
    join(process.env.HOME ?? "", "src/emilkowalski-skills"),
  ];
  for (const g of guesses) {
    if (existsSync(join(g, "skills", "emil-design-eng", "SKILL.md"))) return g;
  }
  return undefined;
}
