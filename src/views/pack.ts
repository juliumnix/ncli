import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertRunnable, loadManifest, validateManifest, type ViewManifest } from "./manifest";

export const VIEW_SOURCE_FILE = ".ncli-source.json";

export type ViewSource =
  | { kind: "dir"; path: string }
  | { kind: "git"; url: string; ref?: string };

export type ViewOrigin = ViewSource & { pin?: string };

export type GitCloneOpts = {
  env?: NodeJS.ProcessEnv;
  uploadPack?: string;
};

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

export function userGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, GIT_TERMINAL_PROMPT: "0" };
}

export function readViewOrigin(dest: string): ViewOrigin | null {
  const file = join(dest, VIEW_SOURCE_FILE);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ViewOrigin>;
    if (raw.kind === "git" && typeof raw.url === "string") {
      return { kind: "git", url: raw.url, ref: raw.ref, pin: raw.pin };
    }
    if (raw.kind === "dir" && typeof raw.path === "string") {
      return { kind: "dir", path: raw.path, pin: raw.pin };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeViewOrigin(dest: string, origin: ViewOrigin): void {
  writeFileSync(join(dest, VIEW_SOURCE_FILE), JSON.stringify(origin, null, 2), "utf8");
}

export function addView(
  src: string,
  viewsDir: string,
  available?: Iterable<string>,
  opts?: GitCloneOpts,
): string {
  const staged = stageSource(src, opts);
  try {
    return installStaged(staged, viewsDir, available);
  } finally {
    staged.cleanup?.();
  }
}

export function updateView(
  id: string,
  viewsDir: string,
  ref?: string,
  available?: Iterable<string>,
  opts?: GitCloneOpts,
): string {
  const dest = join(viewsDir, id);
  const origin = readViewOrigin(dest);
  if (origin?.kind !== "git") throw new Error(`${id} não veio de git; ncli view add <git-url>`);
  const next = ref || origin.ref ? `${origin.url}#${ref || origin.ref}` : origin.url;
  const staged = stageSource(next, opts);
  try {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    return installStaged(staged, viewsDir, available);
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

function installStaged(
  staged: { dir: string; origin: ViewOrigin },
  viewsDir: string,
  available?: Iterable<string>,
): string {
  const packDir = findPackDir(staged.dir);
  const manifest = loadManifest(packDir);
  if (available) assertRunnable(manifest, available);
  const dest = join(viewsDir, manifest.name);
  if (existsSync(dest)) throw new Error(`${dest} já existe`);
  mkdirSync(viewsDir, { recursive: true });
  cpSync(packDir, dest, { recursive: true });
  if (staged.origin.kind === "git") writeViewOrigin(dest, staged.origin);
  loadManifest(dest);
  return dest;
}

function stageSource(raw: string, opts?: GitCloneOpts): { dir: string; origin: ViewOrigin; cleanup?: () => void } {
  const src = parseViewSource(raw);
  if (src.kind === "dir") {
    const abs = resolve(src.path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(`view add espera um diretório ou git url: ${raw}`);
    }
    return { dir: abs, origin: { kind: "dir", path: abs } };
  }
  const dest = mkdtempSync(join(tmpdir(), "ncli-view-"));
  const pin = cloneGit(src.url, dest, src.ref, opts);
  return {
    dir: dest,
    origin: { kind: "git", url: src.url, ref: src.ref, pin },
    cleanup: () => rmSync(dest, { recursive: true, force: true }),
  };
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

function cloneGit(url: string, dest: string, ref: string | undefined, opts: GitCloneOpts = {}): string {
  const env = userGitEnv(opts.env);
  const args = ["-c", "credential.useHttpPath=true"];
  if (useGhCredential(url)) {
    args.push("-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential");
  }
  args.push("clone", "--depth", "1");
  if (opts.uploadPack) args.push("--upload-pack", opts.uploadPack);
  if (ref) args.push("--branch", ref);
  args.push(url, dest);
  const r = Bun.spawnSync(["git", ...args], { env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(cloneFail(url, (r.stderr.toString() || r.stdout.toString()).trim()));
  }
  const pin = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dest, stdout: "pipe", stderr: "pipe" });
  return pin.stdout.toString().trim();
}

function useGhCredential(url: string): boolean {
  return /^https?:\/\/([^/]*\.)?github\.com[:/]/i.test(url) && Boolean(Bun.which("gh"));
}

function cloneFail(url: string, stderr: string): string {
  const safe = url.replace(/^(https?:\/\/)([^/@]+)@/i, "$1***@");
  const auth = /auth|denied|403|401|Username|Permission|could not read/i.test(stderr);
  const hint = auth ? " (repo privado: git/gh já logado, GH_TOKEN ou ssh-agent)" : "";
  return `não deu pra clonar ${safe}${hint}: ${stderr}`;
}
