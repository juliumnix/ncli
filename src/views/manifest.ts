import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HarnessKind } from "../config";

export const HARNESS_IDS = ["claude", "codex", "cursor", "mock", "auto"] as const;
export type ManifestHarness = (typeof HARNESS_IDS)[number];

export type FlowKind = "spark" | "work" | "wait_user" | "result";

export interface ViewAgent {
  id: string;
  role: string;
  harness: ManifestHarness;
  model?: string;
}

export interface FlowStep {
  id: string;
  title: string;
  agent: string;
  kind: FlowKind;
  next?: string;
}

export interface ForkArtifact {
  kind: string;
  label: string;
  text?: string;
  path?: string;
}

export interface ForkDecision {
  id: string;
  text: string;
}

export interface ForkResult {
  summary: string;
  artifacts: ForkArtifact[];
  decisions: ForkDecision[];
  links: string[];
}

export interface ViewRequirements {
  harnesses: ManifestHarness[];
  models?: Partial<Record<ManifestHarness, string>>;
}

export interface ViewManifest {
  name: string;
  version: string;
  description: string;
  requires: ViewRequirements;
  agents: ViewAgent[];
  skills: string[];
  mcp?: string;
  flow: FlowStep[];
}

export interface ViewPackage {
  dir: string;
  manifest: ViewManifest;
  skillDirs: string[];
}

const FLOW_KINDS = new Set<FlowKind>(["spark", "work", "wait_user", "result"]);
const SEMVER = /^\d+\.\d+\.\d+$/;

export function emptyResult(summary: string): ForkResult {
  return { summary, artifacts: [], decisions: [], links: [] };
}

export function formatForkResult(id: { view: string; seq: number }, result: ForkResult): string {
  const bits = [`${id.view} #${id.seq} voltou · ${oneLine(result.summary)}`];
  if (result.decisions.length === 1) bits.push("1 decisão");
  else if (result.decisions.length) bits.push(`${result.decisions.length} decisões`);
  if (result.artifacts.length === 1) bits.push("1 artefato");
  else if (result.artifacts.length) bits.push(`${result.artifacts.length} artefatos`);
  if (result.links.length) bits.push(result.links.join(" "));
  return bits.join(" · ");
}

export function validateManifest(raw: unknown, packDir?: string): ViewManifest {
  if (!raw || typeof raw !== "object") throw new Error("manifest deve ser um objeto");
  const o = raw as Record<string, unknown>;
  const name = reqString(o, "name");
  if (!/^[a-z][a-z0-9]*$/.test(name)) throw new Error(`manifest.name inválido: ${name}`);
  const version = reqString(o, "version");
  if (!SEMVER.test(version)) throw new Error(`manifest.version deve ser semver: ${version}`);
  const description = reqString(o, "description");
  const requires = parseRequires(o.requires);
  const agents = parseAgents(o.agents, requires.harnesses);
  const skills = parseSkills(o.skills);
  const mcp = o.mcp === undefined ? undefined : relPath(String(o.mcp), "mcp");
  const flow = parseFlow(o.flow, agents);
  if (packDir) assertPackFiles(packDir, skills, mcp);
  return { name, version, description, requires, agents, skills, mcp, flow };
}

export function loadManifest(packDir: string): ViewManifest {
  const file = join(packDir, "manifest.json");
  if (!existsSync(file)) throw new Error(`manifest ausente: ${file}`);
  return validateManifest(JSON.parse(readFileSync(file, "utf8")), packDir);
}

export function skillDirsOf(packDir: string, manifest: ViewManifest): string[] {
  return manifest.skills.map((rel) => join(packDir, rel)).filter((d) => existsSync(d) && statSync(d).isDirectory());
}

export function listPackSkills(dir: string): Array<{ id: string; dir: string; description: string }> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: Array<{ id: string; dir: string; description: string }> = [];
  for (const name of readdirSync(dir).sort()) {
    const child = join(dir, name);
    const file = join(child, "SKILL.md");
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, "utf8");
    const desc = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? name;
    out.push({ id: name, dir: child, description: desc });
  }
  return out;
}

export function forkSkillPrompt(pack: ViewPackage): string {
  const skills = pack.skillDirs.flatMap((d) => listPackSkills(d));
  const index = skills.map((s) => `- ${s.id} — ${s.description}  (${s.dir}/SKILL.md)`).join("\n");
  return `You are inside an isolated NCLI fork of type '${pack.manifest.name}' v${pack.manifest.version}.
This fork has its own worktree, memory, skills, and MCP. Do not use main-session skills (ncli-bus, add-view, pstack).
Follow the declared flow. When the flow reaches result, finish. Do not leak work into the main chat.

Exclusive skills:
${index || "(none)"}`;
}

export function checkRequirements(manifest: ViewManifest, available: Iterable<string>): string[] {
  const have = new Set(available);
  return manifest.requires.harnesses.filter((h) => h !== "auto" && !have.has(h));
}

export function stepById(manifest: ViewManifest, id: string): FlowStep | undefined {
  return manifest.flow.find((s) => s.id === id);
}

export function firstStep(manifest: ViewManifest): FlowStep {
  return manifest.flow[0]!;
}

export function nextStep(manifest: ViewManifest, id: string): FlowStep | undefined {
  const cur = stepById(manifest, id);
  return cur?.next ? stepById(manifest, cur.next) : undefined;
}

function parseRequires(raw: unknown): ViewRequirements {
  if (!raw || typeof raw !== "object") throw new Error("manifest.requires é obrigatório");
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.harnesses) || !o.harnesses.length) {
    throw new Error("manifest.requires.harnesses precisa de pelo menos um harness");
  }
  const harnesses = o.harnesses.map((h) => asHarness(String(h)));
  const models: ViewRequirements["models"] = {};
  if (o.models && typeof o.models === "object") {
    for (const [k, v] of Object.entries(o.models as Record<string, unknown>)) {
      models[asHarness(k)] = String(v);
    }
  }
  return { harnesses, models };
}

function parseAgents(raw: unknown, allowed: ManifestHarness[]): ViewAgent[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error("manifest.agents precisa de pelo menos um agente");
  const allow = new Set(allowed);
  const seen = new Set<string>();
  const out: ViewAgent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const id = String(a.id ?? "").trim();
    const role = String(a.role ?? id).trim();
    const harness = asHarness(String(a.harness ?? ""));
    if (!id) throw new Error("agent.id vazio");
    if (seen.has(id)) throw new Error(`agent.id duplicado: ${id}`);
    if (!allow.has(harness) && harness !== "auto") {
      throw new Error(`agent ${id} usa harness ${harness} fora de requires.harnesses`);
    }
    seen.add(id);
    const model = a.model === undefined ? undefined : String(a.model);
    if (model) assertNoPersonal(model, "agent.model");
    out.push({ id, role, harness, model });
  }
  if (!out.length) throw new Error("manifest.agents sem entradas válidas");
  return out;
}

function parseSkills(raw: unknown): string[] {
  const list = Array.isArray(raw) && raw.length ? raw.map((s) => String(s)) : ["skills"];
  return list.map((p) => relPath(p, "skills"));
}

function parseFlow(raw: unknown, agents: ViewAgent[]): FlowStep[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error("manifest.flow precisa de pelo menos um passo");
  const ids = new Set<string>();
  const agentIds = new Set(agents.map((a) => a.id));
  const steps: FlowStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const id = String(s.id ?? "").trim();
    const title = String(s.title ?? id).trim();
    const agent = String(s.agent ?? "").trim();
    const kind = String(s.kind ?? "") as FlowKind;
    if (!id) throw new Error("flow.id vazio");
    if (ids.has(id)) throw new Error(`flow.id duplicado: ${id}`);
    if (!FLOW_KINDS.has(kind)) throw new Error(`flow.kind inválido: ${kind}`);
    if (!agentIds.has(agent)) throw new Error(`flow ${id} aponta agent desconhecido: ${agent}`);
    ids.add(id);
    steps.push({ id, title, agent, kind, next: s.next ? String(s.next) : undefined });
  }
  if (!steps.length) throw new Error("manifest.flow vazio");
  if (steps[0]!.kind !== "spark") throw new Error("o primeiro passo do flow deve ser spark");
  if (!steps.some((s) => s.kind === "result")) throw new Error("o flow precisa de um passo result");
  for (const s of steps) {
    if (s.next && !ids.has(s.next)) throw new Error(`flow ${s.id} next desconhecido: ${s.next}`);
  }
  return steps;
}

function asHarness(raw: string): ManifestHarness {
  if ((HARNESS_IDS as readonly string[]).includes(raw)) return raw as ManifestHarness;
  throw new Error(`harness desconhecido: ${raw}`);
}

function reqString(o: Record<string, unknown>, key: string): string {
  const v = String(o[key] ?? "").trim();
  if (!v) throw new Error(`manifest.${key} é obrigatório`);
  assertNoPersonal(v, key);
  return v;
}

function relPath(p: string, label: string): string {
  const t = p.trim().replaceAll("\\", "/");
  if (!t) throw new Error(`${label} vazio`);
  if (t.startsWith("/") || t.startsWith("~") || t.includes("..") || t.includes(":") || /\$[A-Z_]/.test(t)) {
    throw new Error(`${label} deve ser relativo ao pacote: ${p}`);
  }
  assertNoPersonal(t, label);
  return t;
}

function assertNoPersonal(v: string, label: string): void {
  if (/(^|\/)(\.cursor|\.claude|\.codex|Users\/|home\/)|\bHOME\b/.test(v)) {
    throw new Error(`${label} não pode apontar config pessoal: ${v}`);
  }
}

function assertPackFiles(packDir: string, skills: string[], mcp?: string): void {
  const root = resolve(packDir);
  const view = join(root, "view.ts");
  if (!existsSync(view) && !existsSync(join(root, "view.js"))) {
    throw new Error(`pacote sem view.ts: ${packDir}`);
  }
  for (const rel of skills) {
    const dir = join(root, rel);
    if (!existsSync(dir)) throw new Error(`skills ausente: ${rel}`);
  }
  if (mcp && !existsSync(join(root, mcp))) throw new Error(`mcp ausente: ${mcp}`);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 220);
}

export type { HarnessKind };
