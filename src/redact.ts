import { homedir } from "node:os";
import { dataRoot } from "./config";
import { packageRoot } from "./pkg-root";

export function exposedRoots(extra: string[] = []): string[] {
  const roots = [homedir(), packageRoot(), dataRoot(), process.cwd(), ...extra];
  const uniq = [...new Set(roots.filter((root) => root.length > 1 && root !== "/"))];
  uniq.sort((a, b) => b.length - a.length);
  return uniq;
}

export function redactText(text: string, roots = exposedRoots()): string {
  const home = homedir();
  let out = text;
  for (const root of roots) out = replaceRoot(out, root, root === home ? "~" : ".");
  return out;
}

export function redactPath(path: string, roots = exposedRoots()): string {
  const next = redactText(path, roots);
  if (!next.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(next)) return next || "config.toml";
  const parts = next.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || "config.toml";
}

export function redactValue<T>(value: T, roots = exposedRoots()): T {
  if (typeof value === "string") return redactText(value, roots) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, roots)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactValue(item, roots);
    return out as T;
  }
  return value;
}

export function publicJson(data: unknown, init?: ResponseInit): Response {
  return Response.json(redactValue(data), init);
}

function replaceRoot(text: string, root: string, label: string): string {
  if (!root || !text.includes(root)) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf(root, i);
    if (at < 0) {
      out += text.slice(i);
      break;
    }
    const next = text[at + root.length];
    if (next !== undefined && /[A-Za-z0-9._-]/.test(next)) {
      out += text.slice(i, at + root.length);
      i = at + root.length;
      continue;
    }
    out += text.slice(i, at) + label;
    i = at + root.length;
  }
  return out;
}
