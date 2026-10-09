import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultSkillsDir, listSkills, readSkill } from "./catalog";

export const SHIPPED_VIEWS = ["live", "refino", "review"] as const;

export interface ScaffoldPaths {
  viewsDir: string;
  acpDir: string;
  skillsDir?: string;
  force?: boolean;
}

export function parseId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*$/.test(id)) {
    throw new Error(`id inválido: ${raw} (use [a-z][a-z0-9]*, sem hífen)`);
  }
  return id;
}

export function fillTemplate(raw: string, id: string): string {
  const Id = id[0].toUpperCase() + id.slice(1);
  return raw.replaceAll("{{id}}", id).replaceAll("{{Id}}", Id);
}

export function newView(idRaw: string, paths: ScaffoldPaths, kind: "view" | "mode" = "view"): string {
  const id = parseId(idRaw);
  const dest = join(paths.viewsDir, `${id}.ts`);
  if (existsSync(dest) && !paths.force) throw new Error(`${dest} já existe`);
  const skillId = kind === "mode" ? "add-mode" : "add-view";
  const file = templateFile(skillId, paths.skillsDir);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, fillTemplate(readFileSync(file, "utf8"), id), "utf8");
  return dest;
}

export function removeView(idRaw: string, paths: ScaffoldPaths): string {
  const id = parseId(idRaw);
  if ((SHIPPED_VIEWS as readonly string[]).includes(id) && !paths.force) {
    throw new Error(`view ${id} é shipped; passe --force se o usuário pediu pra apagar`);
  }
  const dest = join(paths.viewsDir, `${id}.ts`);
  if (!existsSync(dest)) throw new Error(`${dest} não existe`);
  unlinkSync(dest);
  return dest;
}

export function newHarness(idRaw: string, paths: ScaffoldPaths): string {
  const id = parseId(idRaw);
  const dest = join(paths.acpDir, `${id}.ts`);
  if (existsSync(dest) && !paths.force) throw new Error(`${dest} já existe`);
  const file = templateFile("add-harness", paths.skillsDir);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, fillTemplate(readFileSync(file, "utf8"), id), "utf8");
  return dest;
}

export function removeHarness(idRaw: string, paths: ScaffoldPaths): string {
  const id = parseId(idRaw);
  if ((id === "claude" || id === "cursor" || id === "codex") && !paths.force) {
    throw new Error(`adapter ${id} é shipped; passe --force se o usuário pediu pra apagar`);
  }
  const dest = join(paths.acpDir, `${id}.ts`);
  if (!existsSync(dest)) throw new Error(`${dest} não existe`);
  unlinkSync(dest);
  return dest;
}

export function runNcli(argv: string[], paths: ScaffoldPaths): string {
  const args = argv.filter((a) => a !== "--force");
  const force = argv.includes("--force") || paths.force;
  const p = { ...paths, force };
  const cmd = args[0] ?? "help";
  switch (cmd) {
    case "help":
    case "-h":
    case "--help":
      return usage();
    case "skills":
      return listSkills(p.skillsDir ?? defaultSkillsDir())
        .map((s) => `${s.id}\t${s.description}`)
        .join("\n");
    case "skill": {
      const id = args[1];
      if (!id) throw new Error("uso: ncli skill <id>");
      const s = readSkill(id, p.skillsDir ?? defaultSkillsDir());
      if (!s) throw new Error(`skill desconhecida: ${id}`);
      return s.body;
    }
    case "new":
      return runNew(args[1], args[2], p);
    case "remove":
      return runRemove(args[1], args[2], p);
    default:
      throw new Error(`comando desconhecido: ${cmd}\n${usage()}`);
  }
}

function runNew(kind: string | undefined, id: string | undefined, paths: ScaffoldPaths): string {
  if (!kind || !id) throw new Error("uso: ncli new <view|mode|harness> <id>");
  switch (kind) {
    case "view":
      return `criou ${newView(id, paths, "view")}`;
    case "mode":
      return `criou ${newView(id, paths, "mode")}`;
    case "harness":
      return `criou ${newHarness(id, paths)}\nainda falta ligar em src/config.ts (HarnessKind) e src/hub.ts (pickHarness). skill: add-harness`;
    case "render":
    case "shortcut":
      return readRequiredSkill(kind === "render" ? "add-render-kind" : "add-shortcut", paths);
    default:
      throw new Error(`não sei criar ${kind}. view | mode | harness | render | shortcut`);
  }
}

function runRemove(kind: string | undefined, id: string | undefined, paths: ScaffoldPaths): string {
  if (!kind || !id) throw new Error("uso: ncli remove <view|harness> <id>");
  switch (kind) {
    case "view":
    case "mode":
      return `removeu ${removeView(id, paths)}`;
    case "harness":
      return `removeu ${removeHarness(id, paths)}\ntire o case em src/hub.ts / src/config.ts se ainda estiver lá`;
    default:
      throw new Error(`não sei remover ${kind}. view | harness`);
  }
}

function readRequiredSkill(id: string, paths: ScaffoldPaths): string {
  const s = readSkill(id, paths.skillsDir ?? defaultSkillsDir());
  if (!s) throw new Error(`skill ${id} ausente`);
  return `edite na mão; skill ${id}:\n\n${s.body}`;
}

function templateFile(skillId: string, skillsDir?: string): string {
  const file = join(skillsDir ?? defaultSkillsDir(), skillId, "template.ts");
  if (!existsSync(file)) throw new Error(`template ausente: ${file}`);
  return file;
}

function usage(): string {
  return `ncli — scaffold do próprio NCLI
  bun run ncli skills
  bun run ncli skill add-view
  bun run ncli new view <id>
  bun run ncli new mode <id>
  bun run ncli new harness <id>
  bun run ncli remove view <id>
  bun run ncli remove harness <id>
  /ncli …  (mesmo comando no chat principal)`;
}
