import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SkillMeta {
  id: string;
  description: string;
  dir: string;
  body: string;
}

export function defaultSkillsDir(ncliRoot = process.cwd()): string {
  const here = join(import.meta.dir, "../../ncli/skills");
  if (existsSync(here)) return here;
  const rooted = join(ncliRoot, "ncli/skills");
  if (existsSync(rooted)) return rooted;
  return here;
}

export function listSkills(root = defaultSkillsDir()): SkillMeta[] {
  if (!existsSync(root)) return [];
  const out: SkillMeta[] = [];
  for (const name of readdirSync(root).sort()) {
    if (name === "pstack") continue;
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    out.push(parseSkill(name, dir, readFileSync(file, "utf8")));
  }
  return out;
}

export function listPstackSkills(root = defaultSkillsDir()): SkillMeta[] {
  const pstack = join(root, "pstack");
  if (!existsSync(pstack)) return [];
  const out: SkillMeta[] = [];
  for (const name of readdirSync(pstack).sort()) {
    const dir = join(pstack, name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    out.push(parseSkill(name, dir, readFileSync(file, "utf8")));
  }
  return out;
}

export function readSkill(id: string, root = defaultSkillsDir()): SkillMeta | undefined {
  return listSkills(root).find((s) => s.id === id) ?? listPstackSkills(root).find((s) => s.id === id);
}

export function skillPrompt(root = defaultSkillsDir()): string {
  const skills = listSkills(root);
  if (!skills.length) return "";
  const index = skills.map((s) => `- ${s.id} — ${s.description}  (${s.dir}/SKILL.md)`).join("\n");
  const pstackN = listPstackSkills(root).length;
  return `NCLI is self-hackable. You are inside this live repo. Views in views/ hot-reload. Skills and MCP servers have one source of truth: ncli/skills/ and ncli/mcp.json. When the user asks to change NCLI itself, read the matching ncli/skills/<id>/SKILL.md and follow it. Do not invent a parallel registry. Do not write ~/.claude, ~/.codex or ~/.cursor.

Scaffold from the terminal or a slash in this chat:
  bun run ncli new view <id>
  bun run ncli remove view <id>
  /ncli new view <id>
  /ncli skills

If the job needs isolation or another seat, open a view:// fork or ask() (ncli/skills/ncli-bus). Keep the change small; subtract before you add.

pstack (${pstackN} skills) is vendored at ncli/skills/pstack/. Same playbooks for every main harness. Start with ncli/skills/pstack/poteto-mode/SKILL.md. Sync: bun run scripts/sync-pstack.ts.

Skills:
${index}`;
}

function parseSkill(fallbackId: string, dir: string, raw: string): SkillMeta {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const body = (fm ? fm[2] : raw).trim();
  const block = fm ? fm[1] : "";
  const name = kv(block, "name") ?? fallbackId;
  const description = kv(block, "description") ?? name;
  return { id: fallbackId, description, dir, body };
}

function kv(block: string, key: string): string | undefined {
  const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m?.[1]?.trim();
}
