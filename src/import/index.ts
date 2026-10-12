import type { Message } from "../types";
import { ImportLedger } from "./ledger";
import { listSessionFiles, parseSessionFile } from "./parse";
import { defaultImportRoots, rootFor } from "./roots";
import type { ImportProgress } from "./progress";
import type { ImportApply, ImportLine, ImportPreview, ImportRoots, ImportSource } from "./types";

export type { ImportApply, ImportArgv, ImportLine, ImportPreview, ImportRoots, ImportSource } from "./types";
export type { ImportProgress } from "./progress";
export { formatImportChip, importPct } from "./progress";
export { isImportSource, parseImportArgv } from "./args";
export { defaultImportRoots, rootFor } from "./roots";
export { listSessionFiles, parseSessionFile, textOf } from "./parse";
export { fingerprintOf, lineOf } from "./fingerprint";

export class Importer {
  readonly roots: ImportRoots;
  readonly ledger: ImportLedger;

  constructor(dir: string, roots: ImportRoots = defaultImportRoots()) {
    this.roots = roots;
    this.ledger = new ImportLedger(dir);
  }

  preview(source: ImportSource, since?: string): ImportPreview {
    const root = rootFor(source, this.roots);
    const files = listSessionFiles(root, source);
    const collected: ImportLine[] = [];
    let skipped = 0;
    const sinceMs = since ? Date.parse(since) : undefined;
    for (const file of files) {
      for (const line of parseSessionFile(source, file)) {
        if (sinceMs !== undefined) {
          const at = Date.parse(line.at);
          if (!Number.isFinite(at) || at < sinceMs) {
            skipped += 1;
            continue;
          }
        }
        collected.push(line);
      }
    }
    collected.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    let seenCount = 0;
    const lines: ImportLine[] = [];
    for (const line of collected) {
      if (this.ledger.has(line.fingerprint)) {
        seenCount += 1;
        continue;
      }
      lines.push(line);
    }
    return {
      source,
      root,
      sessions: files.length,
      lines,
      newCount: lines.length,
      seenCount,
      skipped,
      since,
    };
  }

  async apply(
    source: ImportSource,
    since: string | undefined,
    append: (line: ImportLine) => Message | undefined,
    already: (line: ImportLine) => boolean,
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportApply> {
    const preview = this.preview(source, since);
    const total = preview.lines.length;
    onProgress?.({ source, done: 0, total });
    let applied = 0;
    const marked: string[] = [];
    for (let i = 0; i < preview.lines.length; i++) {
      const line = preview.lines[i]!;
      if (already(line) || this.ledger.has(line.fingerprint)) {
        marked.push(line.fingerprint);
      } else {
        append(line);
        marked.push(line.fingerprint);
        applied += 1;
      }
      onProgress?.({ source, done: i + 1, total });
      if (onProgress) await Bun.sleep(0);
    }
    this.ledger.add(marked);
    return { preview, applied };
  }
}

export function alreadyInLog(log: readonly Message[], line: ImportLine): boolean {
  return log.some((m) => m.kind === line.kind && m.text === line.text && m.date === line.at);
}

export function formatPreview(preview: ImportPreview, verbose = false): string {
  const since = preview.since ? ` · desde ${preview.since.slice(0, 10)}` : "";
  const extra = preview.skipped ? ` · ${preview.skipped} fora do recorte` : "";
  const lines = [
    `import ${preview.source}${since} · ${count(preview.sessions, "sessão", "sessões")} · ${count(preview.newCount, "nova", "novas")} · ${count(preview.seenCount, "já vista", "já vistas")}${extra}`,
  ];
  if (verbose) lines.push(preview.root);
  lines.push(`aplicar: /ncli import ${preview.source} --apply`);
  return lines.join("\n");
}

export function formatApply(result: ImportApply): string {
  return `import ${result.preview.source} · aplicou ${result.applied} · ${count(result.preview.seenCount, "já estava no ledger", "já estavam no ledger")}`;
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}
