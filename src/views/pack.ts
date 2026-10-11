import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadManifest, validateManifest, type ViewManifest } from "./manifest";

export function addView(src: string, viewsDir: string): string {
  const abs = resolve(src);
  if (!statSync(abs).isDirectory()) throw new Error(`view add espera um diretório: ${src}`);
  const manifest = loadManifest(abs);
  const dest = join(viewsDir, manifest.name);
  if (existsSync(dest)) throw new Error(`${dest} já existe`);
  mkdirSync(viewsDir, { recursive: true });
  cpSync(abs, dest, { recursive: true });
  loadManifest(dest);
  return dest;
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

