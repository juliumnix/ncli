import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SESSION_CAP = 256 * 1024;

export type LiveSeat = "claude" | "codex" | "cursor";

export interface SeatSessionPlan {
  id: string;
  resume: boolean;
  rotated: boolean;
}

export interface SeatTurnTrace {
  seat: LiveSeat;
  spawnAt: number;
  turnAt: number;
  initAt?: number;
  firstTokenAt?: number;
  resultAt?: number;
  sessionId: string;
  rotated: boolean;
  hot: boolean;
}

export type SessionBlob = {
  id: string;
  path: string;
  bytes: number;
};

export function isLiveSeat(id: string): id is LiveSeat {
  return id === "claude" || id === "codex" || id === "cursor";
}

export function safeSession(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function sessionCap(envKey: string, fallback = DEFAULT_SESSION_CAP): number {
  const n = Number(process.env[envKey] ?? "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function fileBytes(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function walkFiles(dir: string, visit: (abs: string) => void): void {
  if (!existsSync(dir)) return;
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
    if (st.isDirectory()) walkFiles(abs, visit);
    else if (st.isFile()) visit(abs);
  }
}

function sessionsDir(dataDir: string): string {
  const dir = join(dataDir, "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function seatIdPath(dataDir: string, name: string, seat: LiveSeat): string {
  const base = join(sessionsDir(dataDir), safeSession(name));
  return seat === "claude" ? `${base}.id` : `${base}.${seat}.id`;
}

export function seatModelPath(dataDir: string, name: string, seat: LiveSeat): string {
  const base = join(sessionsDir(dataDir), safeSession(name));
  return seat === "claude" ? `${base}.model` : `${base}.${seat}.model`;
}

export function seatBlobPath(dataDir: string, name: string, seat: LiveSeat): string {
  const base = join(sessionsDir(dataDir), safeSession(name));
  return seat === "claude" ? `${base}.blob` : `${base}.${seat}.blob`;
}

export function persistSeatId(dataDir: string, name: string, seat: LiveSeat, id: string): void {
  if (!id) return;
  writeFileSync(seatIdPath(dataDir, name, seat), id, "utf8");
}

export function readSeatId(dataDir: string, name: string, seat: LiveSeat): string {
  const path = seatIdPath(dataDir, name, seat);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

export function persistSeatModel(dataDir: string, name: string, seat: LiveSeat, model: string): void {
  writeFileSync(seatModelPath(dataDir, name, seat), model, "utf8");
}

export function readSeatModel(dataDir: string, name: string, seat: LiveSeat): string | undefined {
  const path = seatModelPath(dataDir, name, seat);
  if (!existsSync(path)) return undefined;
  const model = readFileSync(path, "utf8").trim();
  return model || undefined;
}

export function persistSeatBlob(dataDir: string, name: string, seat: LiveSeat, blob: SessionBlob): void {
  if (!blob.id || !blob.path) return;
  writeFileSync(seatBlobPath(dataDir, name, seat), JSON.stringify(blob), "utf8");
}

export function readSeatBlob(dataDir: string, name: string, seat: LiveSeat): SessionBlob | undefined {
  const path = seatBlobPath(dataDir, name, seat);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.path !== "string" || typeof rec.bytes !== "number") return undefined;
  if (!rec.id || !rec.path || !Number.isFinite(rec.bytes)) return undefined;
  return { id: rec.id, path: rec.path, bytes: rec.bytes };
}

export function resumeOrRotate(opts: {
  existing: string;
  resume?: boolean;
  capBytes: number;
  bytes: number;
}): SeatSessionPlan {
  if (opts.existing && opts.resume !== false) {
    if (opts.bytes <= opts.capBytes) return { id: opts.existing, resume: true, rotated: false };
    return { id: "", resume: false, rotated: true };
  }
  return { id: opts.existing, resume: false, rotated: false };
}

export function formatSeatTrace(trace: SeatTurnTrace): string {
  const origin = trace.hot ? trace.turnAt : trace.spawnAt;
  const init = trace.initAt != null ? `${Math.round(trace.initAt - origin)}ms` : "-";
  const token = trace.firstTokenAt != null ? `${Math.round(trace.firstTokenAt - origin)}ms` : "-";
  return `${trace.seat} ${trace.hot ? "hot" : "cold"} session=${trace.sessionId}${trace.rotated ? " rotated" : ""} ${trace.hot ? "turn" : "spawn"}→init=${init} ${trace.hot ? "turn" : "spawn"}→token=${token}`;
}

export function debugSeat(msg: string): void {
  if (process.env.NCLI_DEBUG === "1") console.error(msg);
}
