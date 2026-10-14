import { homedir } from "node:os";
import { join } from "node:path";
import type { ImportRoots, ImportSource } from "./types";

function userHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

export function defaultImportRoots(env: NodeJS.ProcessEnv = process.env): ImportRoots {
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return {
    claude: env.NCLI_IMPORT_CLAUDE?.trim() || join(claudeHome, "projects"),
    codex: env.NCLI_IMPORT_CODEX?.trim() || join(codexHome, "sessions"),
    cursor: env.NCLI_IMPORT_CURSOR?.trim() || join(homedir(), ".cursor", "projects"),
  };
}

export function rootFor(source: ImportSource, roots: ImportRoots): string {
  switch (source) {
    case "claude":
      return roots.claude;
    case "codex":
      return roots.codex;
    case "cursor":
      return roots.cursor;
    default: {
      const _n: never = source;
      throw new Error(`fonte desconhecida: ${_n}`);
    }
  }
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

export function displayPublicPath(root: string, home = userHome()): string {
  if (!root || !isAbsolutePath(root)) return root;
  if (root === home) return "~";
  if (root.startsWith(`${home}/`)) return `~/${root.slice(home.length + 1)}`;
  if (root.startsWith(`${home}\\`)) return `~\\${root.slice(home.length + 1)}`;
  const parts = root.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? "repo";
}

export function displayImportRoot(root: string, home = homedir()): string {
  return displayPublicPath(root, home);
}

export function publicImportPreview<T extends { root: string }>(preview: T, home = userHome()): T {
  return { ...preview, root: displayPublicPath(preview.root, home) };
}

export function publicSpark<T extends { repo?: string }>(spark: T, home = userHome()): T {
  if (!spark.repo) return spark;
  return { ...spark, repo: displayPublicPath(spark.repo, home) };
}
