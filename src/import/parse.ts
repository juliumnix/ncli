import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { lineOf } from "./fingerprint";
import type { ImportLine, ImportSource } from "./types";

export function listSessionFiles(root: string, source: ImportSource): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  walk(root, (abs) => {
    if (!abs.endsWith(".jsonl")) return;
    if (source === "cursor" && !cursorFileOk(root, abs)) return;
    out.push(abs);
  });
  return out.sort();
}

function cursorFileOk(root: string, abs: string): boolean {
  if (abs.includes("agent-transcripts")) return true;
  return dirname(abs) === root.replace(/\/+$/, "");
}

function walk(dir: string, visit: (abs: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "." || name === ".." || name.startsWith(".")) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, visit);
    else if (st.isFile()) visit(abs);
  }
}

export function* parseSessionLines(source: ImportSource, file: string): Generator<ImportLine> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const session = sessionIdOf(file);
  const fallbackAt = fileMtime(file);
  let sessionMeta = session;
  for (const row of raw.split("\n")) {
    const trimmed = row.trim();
    if (!trimmed) continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!json || typeof json !== "object") continue;
    const rec = json as Record<string, unknown>;
    if (source === "codex" && rec.type === "session_meta") {
      const payload = asRecord(rec.payload);
      const id = typeof payload?.id === "string" ? payload.id : "";
      if (id) sessionMeta = id;
      continue;
    }
    const parsed = parseRow(source, rec, sessionMeta, fallbackAt, file);
    if (parsed) yield parsed;
  }
}

export function parseSessionFile(source: ImportSource, file: string): ImportLine[] {
  return [...parseSessionLines(source, file)];
}

function parseRow(
  source: ImportSource,
  rec: Record<string, unknown>,
  session: string,
  fallbackAt: string,
  file: string,
): ImportLine | undefined {
  switch (source) {
    case "claude":
      return parseClaude(rec, session, fallbackAt, file);
    case "codex":
      return parseCodex(rec, session, fallbackAt, file);
    case "cursor":
      return parseCursor(rec, session, fallbackAt, file);
    default: {
      const _n: never = source;
      throw new Error(`fonte desconhecida: ${_n}`);
    }
  }
}

function parseClaude(rec: Record<string, unknown>, session: string, fallbackAt: string, file: string): ImportLine | undefined {
  if (rec.isSidechain === true) return undefined;
  const type = String(rec.type ?? "");
  if (type !== "user" && type !== "assistant") return undefined;
  const message = asRecord(rec.message);
  const text = textOf(message?.content ?? rec.content);
  const at = isoOf(rec.timestamp) ?? fallbackAt;
  const sid = typeof rec.sessionId === "string" && rec.sessionId ? rec.sessionId : session;
  const cwd = cwdOf(rec, file);
  if (type === "user") return lineOf("claude", sid, at, "user", text, undefined, cwd);
  return lineOf("claude", sid, at, "talk", text, "claude", cwd);
}

function parseCodex(rec: Record<string, unknown>, session: string, fallbackAt: string, file: string): ImportLine | undefined {
  const type = String(rec.type ?? "");
  const payload = asRecord(rec.payload) ?? rec;
  const at = isoOf(rec.timestamp) ?? fallbackAt;
  const cwd = cwdOf(payload, file) ?? cwdOf(rec, file);
  if (type === "event_msg") {
    const kind = String(payload.type ?? "");
    const text = textOf(payload.message ?? payload.text ?? payload.content);
    if (kind === "user_message") return lineOf("codex", session, at, "user", text, undefined, cwd);
    if (kind === "agent_message") return lineOf("codex", session, at, "talk", text, "codex", cwd);
    return undefined;
  }
  if (type === "response_item") {
    const item = String(payload.type ?? "");
    if (item !== "message") return undefined;
    const role = String(payload.role ?? "");
    const text = textOf(payload.content ?? payload.message ?? payload.text);
    if (role === "user") return lineOf("codex", session, at, "user", text, undefined, cwd);
    if (role === "assistant") return lineOf("codex", session, at, "talk", text, "codex", cwd);
    return undefined;
  }
  return undefined;
}

function parseCursor(rec: Record<string, unknown>, session: string, fallbackAt: string, file: string): ImportLine | undefined {
  const role = String(rec.role ?? rec.type ?? "");
  const message = asRecord(rec.message);
  const text = textOf(message?.content ?? rec.content ?? rec.text);
  const at = isoOf(rec.timestamp ?? rec.createdAt ?? rec.at) ?? fallbackAt;
  const cwd = cwdOf(rec, file);
  if (role === "user") return lineOf("cursor", session, at, "user", text, undefined, cwd);
  if (role === "assistant") return lineOf("cursor", session, at, "talk", text, "cursor", cwd);
  return undefined;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block.trim()) parts.push(block.trim());
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    const type = String(rec.type ?? "");
    if (type === "text" || type === "output_text" || type === "input_text") {
      const text = typeof rec.text === "string" ? rec.text.trim() : "";
      if (text) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function fileMtime(file: string): string {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}

function sessionIdOf(file: string): string {
  const parts = file.split("/").filter(Boolean);
  const name = parts.at(-1) ?? file;
  return name.replace(/\.jsonl$/i, "");
}

function cwdOf(rec: Record<string, unknown>, _file: string): string | undefined {
  if (typeof rec.cwd === "string" && rec.cwd.trim()) return rec.cwd.trim();
  return undefined;
}

