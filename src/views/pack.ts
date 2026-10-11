import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertRunnable, loadManifest, validateManifest, type ViewManifest } from "./manifest";

export interface ViewSource {
  kind: "dir" | "git";
  path?: string;
  url?: string;
  ref?: string;
}

export function parseViewSource(raw: string): ViewSource {
  const t = raw.trim();
  const cut = t.match(/^(.*?)(?:#(.+))?$/);
  const base = (cut?.[1] ?? t).trim();
  const ref = cut?.[2]?.trim() || undefined;
  if (/^(https?:\/\/|git@|file:\/\/)/.test(base) || base.endsWith(".git")) {
    return { kind: "git", url: base, ref };
  }
  return { kind: "dir", path: base };
}

export function addView(src: string, viewsDir: string, available?: Iterable<string>): string {
  const staged = stageSource(src);
  try {
    const packDir = findPackDir(staged.dir);
    const manifest = loadManifest(packDir);
    if (available) assertRunnable(manifest, available);
    const dest = join(viewsDir, manifest.name);
    if (existsSync(dest)) throw new Error(`${dest} já existe`);
    mkdirSync(viewsDir, { recursive: true });
    cpSync(packDir, dest, { recursive: true });
    loadManifest(dest);
    return dest;
  } finally {
    staged.cleanup?.();
  }
}

export function packView(id: string, viewsDir: string, outDir: string): string {
  const src = join(viewsDir, id);
  const manifest = loadManifest(src);
  mkdirSync(outDir, { recursive: true });
  const dest = join(outDir, `${manifest.name}-${manifest.version}`);
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  writeFileSync(join(dest, "PACK.json"), JSON.stringify(packMeta(manifest), null, 2), "utf8");
  loadManifest(dest);
  return dest;
}

export function packMeta(manifest: ViewManifest): Record<string, unknown> {
  return {
    name: manifest.name,
    version: manifest.version,
    requires: manifest.requires,
    agents: manifest.agents,
    packedAt: new Date().toISOString(),
  };
}

export function readPackedManifest(dir: string): ViewManifest {
  return validateManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")), dir);
}

function stageSource(raw: string): { dir: string; cleanup?: () => void } {
  const src = parseViewSource(raw);
  if (src.kind === "dir") {
    const abs = resolve(src.path ?? raw);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`view add espera um diretório ou git url: ${raw}`);
    }
    return { dir: abs };
  }
  const dest = mkdtempSync(join(tmpdir(), "ncli-view-"));
  cloneGit(src.url ?? raw, dest, src.ref);
  return { dir: dest, cleanup: () => rmSync(dest, { recursive: true, force: true }) };
}

function findPackDir(root: string): string {
  if (existsSync(join(root, "manifest.json"))) return root;
  const views = join(root, "views");
  if (existsSync(views) && statSync(views).isDirectory()) {
    const hits = readdirSync(views)
      .map((name) => join(views, name))
      .filter((d) => existsSync(join(d, "manifest.json")));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      throw new Error(`vários pacotes em ${root}; passe o diretório do pacote`);
    }
  }
  throw new Error(`manifest.json ausente em ${root}`);
}

function cloneGit(url: string, dest: string, ref?: string): void {
  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  args.push(url, dest);
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(`não deu pra clonar ${url}: ${(r.stderr.toString() || r.stdout.toString()).trim()}`);
  }
}
