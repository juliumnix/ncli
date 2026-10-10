#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.NCLI_ROOT ?? process.cwd();
const dest = join(root, "ncli/skills/pstack");
const src =
  process.env.PSTACK_SRC ??
  findLocal() ??
  "";

if (!src || !existsSync(join(src, "skills"))) {
  console.error("Set PSTACK_SRC to a cursor/plugins/pstack checkout (needs skills/ + LICENSE).");
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(src, "skills"), dest, { recursive: true });
if (existsSync(join(src, "LICENSE"))) cpSync(join(src, "LICENSE"), join(dest, "LICENSE"));
writeFileSync(
  join(dest, "SOURCE.md"),
  `# pstack skills (vendored)

- Upstream: https://github.com/cursor/plugins (path \`pstack/\`)
- License: MIT — see LICENSE
- Synced from: ${src}
- Date: ${new Date().toISOString().slice(0, 10)}
- Sync: bun run scripts/sync-pstack.ts

These files are for developing NCLI in Cursor. They are not injected into runtime Claude/Codex/Cursor spawns.
`,
  "utf8",
);
console.log(`synced pstack skills → ${dest}`);

function findLocal(): string | undefined {
  const home = process.env.HOME ?? "";
  const cache = join(home, ".cursor/plugins/cache/cursor-public");
  if (!existsSync(cache)) return undefined;
  const proc = Bun.spawnSync(["bash", "-lc", `find ${JSON.stringify(cache)} -path '*/skills/poteto-mode/SKILL.md' 2>/dev/null | head -1`]);
  const hit = proc.stdout.toString().trim();
  if (!hit) return undefined;
  return join(hit, "../..");
}
