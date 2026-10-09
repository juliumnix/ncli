import { existsSync, mkdirSync, watchFile, unwatchFile, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NcliConfig } from "../config";
import type { HarnessEvent, SeatLaunch } from "./types";
import type { SeatId } from "../types";

const PSTACK_RE = /\b(pstack-codex|pstack-cursor)\b[\s\S]*?--out\s+(\S+)/;

export function detectSeatCommand(cmd: string): { seat: SeatId; out: string } | null {
  const m = cmd.match(PSTACK_RE);
  if (!m) return null;
  const seat: SeatId = m[1] === "pstack-codex" ? "codex" : "cursor";
  return { seat, out: m[2] };
}

export async function* watchSeatOut(outPath: string, seat: SeatId, signal?: AbortSignal): AsyncGenerator<HarnessEvent> {
  const logPath = `${outPath}.log`;
  mkdirSync(dirname(outPath), { recursive: true });
  yield { type: "seat", seat, status: "start" };
  let seen = 0;
  const read = (): string => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
  while (!signal?.aborted) {
    const cur = read();
    if (cur.length > seen) {
      const chunk = cur.slice(seen);
      seen = cur.length;
      yield { type: "seat", seat, status: "delta", text: chunk };
    }
    if (existsSync(outPath) && !isEmptyFile(outPath)) {
      const finalText = readFileSync(outPath, "utf8").trim();
      yield { type: "seat", seat, status: "done", text: finalText };
      return;
    }
    await sleep(80);
  }
  yield { type: "seat", seat, status: "error", text: "aborted" };
}

function isEmptyFile(p: string): boolean {
  try {
    return readFileSync(p, "utf8").trim().length === 0;
  } catch {
    return true;
  }
}

export async function launchPstack(cfg: NcliConfig, launch: SeatLaunch): Promise<void> {
  mkdirSync(dirname(launch.outPath), { recursive: true });
  const promptFile = `${launch.outPath}.prompt`;
  writeFileSync(promptFile, launch.prompt, "utf8");
  const bin = launch.seat === "codex" ? cfg.pstackCodex : cfg.pstackCursor;
  const args = ["--model", launch.model ?? defaultModel(launch.seat), "--prompt-file", promptFile, "--out", launch.outPath];
  if (launch.seat === "codex" && launch.write) args.push("--write");
  if (launch.seat === "codex" && launch.cwd) args.push("--cd", launch.cwd);
  const proc = Bun.spawn([bin, ...args], {
    cwd: launch.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const log = `${launch.outPath}.log`;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  writeFileSync(log, `${stdout}\n${stderr}`, "utf8");
  const code = await proc.exited;
  if (!existsSync(launch.outPath)) {
    writeFileSync(launch.outPath, stdout.trim() || `(${launch.seat} exit ${code})`, "utf8");
  }
  writeFileSync(`${launch.outPath}.json`, JSON.stringify({ seat: launch.seat, exit: code }), "utf8");
}

function defaultModel(seat: SeatId): string {
  switch (seat) {
    case "claude":
      return "opus";
    case "codex":
      return "gpt-5.4";
    case "cursor":
      return "grok";
    default:
      return "default";
  }
}

export function mockWriteSeat(outPath: string, seat: SeatId, text: string, logLines: string[]): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(`${outPath}.log`, logLines.join("\n") + "\n", "utf8");
  writeFileSync(outPath, text, "utf8");
  writeFileSync(`${outPath}.json`, JSON.stringify({ seat, mock: true }), "utf8");
}

export { watchFile, unwatchFile };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
