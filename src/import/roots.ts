import { homedir } from "node:os";
import { join } from "node:path";
import type { ImportRoots, ImportSource } from "./types";

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

export function displayImportRoot(root: string, home = homedir()): string {
  if (root === home) return "~";
  const sep = root.startsWith(`${home}/`) ? "/" : root.startsWith(`${home}\\`) ? "\\" : "";
  if (!sep) return root;
  return `~${sep}${root.slice(home.length + 1)}`;
}

export function publicImportPreview<T extends { root: string }>(preview: T, home = homedir()): T {
  return { ...preview, root: displayImportRoot(preview.root, home) };
}
