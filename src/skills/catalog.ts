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
    if (name === "pstack" || name === "emil") continue;
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    out.push(parseSkill(name, dir, readFileSync(file, "utf8")));
  }
  return out;
}

export function listPstackSkills(root = defaultSkillsDir()): SkillMeta[] {
  return listVendorSkills("pstack", root);
}

export function listEmilSkills(root = defaultSkillsDir()): SkillMeta[] {
  return listVendorSkills("emil", root);
}

export function listVendorSkills(vendor: string, root = defaultSkillsDir()): SkillMeta[] {
  const base = join(root, vendor);
  if (!existsSync(base)) return [];
  const out: SkillMeta[] = [];
  for (const name of readdirSync(base).sort()) {
    const dir = join(base, name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    out.push(parseSkill(name, dir, readFileSync(file, "utf8")));
  }
  return out;
}

export function readSkill(id: string, root = defaultSkillsDir()): SkillMeta | undefined {
  return (
    listSkills(root).find((s) => s.id === id)
    ?? listPstackSkills(root).find((s) => s.id === id)
    ?? listEmilSkills(root).find((s) => s.id === id)
  );
}

export function runtimeSkillDirs(root = defaultSkillsDir()): string[] {
  const dirs = listSkills(root).map((s) => s.dir);
  const emil = join(root, "emil");
  if (existsSync(emil)) dirs.push(emil);
  return dirs;
}

let promptMemo: { key: string; text: string } | null = null;

function vendorSkillCount(vendor: string, root: string): number {
  const base = join(root, vendor);
  if (!existsSync(base)) return 0;
  let n = 0;
  for (const name of readdirSync(base)) {
    if (existsSync(join(base, name, "SKILL.md"))) n += 1;
  }
  return n;
}

function promptCacheKey(root: string): string {
  if (!existsSync(root)) return root;
  const parts = [root];
  for (const name of readdirSync(root).sort()) {
    if (name === "pstack" || name === "emil") {
      parts.push(`${name}:${vendorSkillCount(name, root)}`);
      continue;
    }
    const file = join(root, name, "SKILL.md");
    try {
      parts.push(`${name}:${statSync(file).mtimeMs}`);
    } catch {
      parts.push(name);
    }
  }
  return parts.join("|");
}

export function skillPrompt(root = defaultSkillsDir()): string {
  const key = promptCacheKey(root);
  if (promptMemo?.key === key) return promptMemo.text;
  const skills = listSkills(root);
  if (!skills.length) {
    promptMemo = { key, text: "" };
    return "";
  }
  const index = skills.map((s) => `- ${s.id} — ${s.description}  (${s.dir}/SKILL.md)`).join("\n");
  const emilN = vendorSkillCount("emil", root);
  const text = `NCLI is self-hackable. You are inside this live repo. Views in views/ hot-reload. Skills and MCP servers have one source of truth: ncli/skills/ and ncli/mcp.json. When the user asks to change NCLI itself, read the matching ncli/skills/<id>/SKILL.md and follow it. Do not invent a parallel registry. Do not write ~/.claude, ~/.codex or ~/.cursor.

Scaffold from the terminal or a slash in this chat:
  bun run ncli new view <id>
  bun run ncli remove view <id>
  /ncli new view <id>
  /ncli skills

If the job needs isolation or another seat, open a view:// spark or ask() (ncli/skills/ncli-bus). Keep the change small; subtract before you add.

emil (${emilN} skills) is vendored at ncli/skills/emil/. Motion and UI craft when the work is visual. Start with ncli/skills/emil/emil-design-eng/SKILL.md. Sync: bun run scripts/sync-emil.ts.

Skills:
${index}`;
  promptMemo = { key, text };
  return text;
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
