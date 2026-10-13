import { utf8Bytes } from "../util";

export function importKnownLines(
  log: ReadonlyArray<{ hops?: string; kind: string; text: string }>,
  budget = 12_000,
): string {
  const lines: string[] = [];
  let bytes = 0;
  for (const m of log) {
    if (!m.hops?.startsWith("import:")) continue;
    const row = `${m.kind}: ${m.text}`;
    const n = utf8Bytes(row);
    if (bytes + n > budget) break;
    lines.push(row);
    bytes += n;
  }
  return lines.join("\n");
}
