import { createHash } from "node:crypto";
import type { ImportLine, ImportSource } from "./types";

export function fingerprintOf(line: Omit<ImportLine, "fingerprint">): string {
  return createHash("sha256")
    .update(`${line.source}\0${line.session}\0${line.at}\0${line.kind}\0${line.text}`)
    .digest("hex")
    .slice(0, 32);
}

export function lineOf(
  source: ImportSource,
  session: string,
  at: string,
  kind: ImportLine["kind"],
  text: string,
  seat?: ImportLine["seat"],
  cwd?: string,
): ImportLine | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const base = { source, session, at, kind, text: trimmed, seat, cwd };
  return { ...base, fingerprint: fingerprintOf(base) };
}
