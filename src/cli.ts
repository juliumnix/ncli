import { join } from "node:path";
import { runNcli } from "./skills/scaffold";

const root = process.env.NCLI_ROOT ?? process.cwd();
try {
  const out = runNcli(Bun.argv.slice(2), {
    viewsDir: join(root, "views"),
    acpDir: join(root, "src/acp"),
    skillsDir: join(root, "ncli/skills"),
  });
  console.log(out);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
