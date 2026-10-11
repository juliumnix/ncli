import type { ImportArgv, ImportSource } from "./types";

export function parseImportArgv(argv: string[]): ImportArgv {
  const tokens = argv.filter(Boolean);
  const source = tokens[0];
  if (!isImportSource(source)) {
    throw new Error("uso: /ncli import claude|codex|cursor [--since ISO] [--preview|--apply] [--verbose]");
  }
  let since: string | undefined;
  let apply = false;
  let verbose = false;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--apply") {
      apply = true;
      continue;
    }
    if (tok === "--preview") {
      apply = false;
      continue;
    }
    if (tok === "--verbose") {
      verbose = true;
      continue;
    }
    if (tok === "--since") {
      const next = tokens[++i];
      if (!next) throw new Error("uso: --since precisa de uma data ISO");
      since = parseSince(next);
      continue;
    }
    if (tok.startsWith("--since=")) {
      since = parseSince(tok.slice("--since=".length));
      continue;
    }
    throw new Error(`flag desconhecida: ${tok}`);
  }
  return { source, since, apply, verbose };
}

export function isImportSource(value: string | undefined): value is ImportSource {
  return value === "claude" || value === "codex" || value === "cursor";
}

function parseSince(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`data inválida: ${raw}`);
  return d.toISOString();
}
