import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { NcliConfig } from "../config";
import { flattenLine, utf8Bytes } from "../util";
import type { CompactInput, Compressor } from "./store";

export const CURSOR_COMPACT_PROMPT =
  "One-line memory for NCLI. Output only the line. Keep user words, decisions, ids. Drop tool noise.";

export type CompactRunner = (prompt: string, model: string) => Promise<string>;

export interface CompactProgress {
  running: boolean;
  nodes: number;
  tokensToday: number;
  budget: number;
  model: string;
}

export type CompactListener = (ev: CompactProgress) => void;

interface Job {
  input: CompactInput;
  hash: string;
  resolve: (s: string) => void;
  reject: (e: unknown) => void;
}

export interface CompactLog {
  t: string;
  model: string;
  items: number;
  tokensIn: number;
  tokensOut: number;
  cached: number;
  skipped: number;
}

interface Budget {
  day: string;
  tokens: number;
  calls: number;
}

export function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(utf8Bytes(s) / 4));
}

export function nodeHash(input: CompactInput): string {
  return createHash("sha256")
    .update(input.kind)
    .update("\n")
    .update(input.source)
    .update("\n")
    .update(String(input.nodeBytes))
    .digest("hex")
    .slice(0, 24);
}

export function cursorCompressor(cfg: NcliConfig, runner?: CompactRunner, onProgress?: CompactListener): Compressor {
  const run = runner ?? defaultCursorRunner(cfg);
  const cache = loadCache(cfg.dataDir);
  const queue: Job[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const batchN = cfg.compactBatch;

  const flush = () => {
    timer = null;
    const taken = queue.splice(0, Math.max(queue.length, batchN));
    if (!taken.length) return;
    const batches = splitJobsByTokens(taken, {
      maxItems: batchN,
      maxInputTokens: cfg.compactMaxInputTokens,
    });
    void (async () => {
      for (const jobs of batches) await runBatch(cfg, run, cache, jobs, onProgress);
    })();
  };

  return async (input) => {
    const skipAt = cfg.compactSkipTokens;
    const raw = input.kind === "merge" ? `${input.left ?? ""} ${input.right ?? ""}` : input.source;
    if (estimateTokens(raw) <= skipAt) {
      logCall(cfg.dataDir, { t: new Date().toISOString(), model: cfg.compactModel, items: 1, tokensIn: 0, tokensOut: 0, cached: 0, skipped: 1 });
      return cut(flattenLine(raw), input.nodeBytes);
    }
    const hash = nodeHash(input);
    const hit = cache.get(hash);
    if (hit) {
      logCall(cfg.dataDir, { t: new Date().toISOString(), model: cfg.compactModel, items: 1, tokensIn: 0, tokensOut: 0, cached: 1, skipped: 0 });
      return cut(hit, input.nodeBytes);
    }
    const budget = loadBudget(cfg);
    if (budget.tokens >= cfg.compactBudgetTokens) {
      return cut(flattenLine(raw), input.nodeBytes);
    }
    return new Promise((resolve, reject) => {
      queue.push({ input, hash, resolve, reject });
      if (queue.length >= batchN) flush();
      else if (!timer) timer = setTimeout(flush, cfg.compactDebounceMs || 2500);
    });
  };
}

export function jobPrompt(jobs: Array<{ input: CompactInput }>): string {
  const body = jobs
    .map((j, i) => {
      const step =
        j.input.kind === "leaf"
          ? `Compress:\n${j.input.source}`
          : `Merge:\n${j.input.left}\n${j.input.right}`;
      return `### ${i + 1} (max ${j.input.nodeBytes} bytes)\n${step}`;
    })
    .join("\n\n");
  return `${CURSOR_COMPACT_PROMPT}\nOutput ${jobs.length} lines, numbered 1..${jobs.length}. Nothing else.\n\n${body}`;
}

export function splitJobsByTokens<T extends { input: CompactInput }>(
  jobs: T[],
  opts: { maxItems: number; maxInputTokens: number },
): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const job of jobs) {
    const next = [...cur, job];
    const overItems = next.length > opts.maxItems;
    const overTokens = estimateTokens(jobPrompt(next)) > opts.maxInputTokens;
    if (cur.length && (overItems || overTokens)) {
      out.push(cur);
      cur = [job];
      continue;
    }
    cur = next;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function compactSnapshot(cfg: NcliConfig, running = false, lastNodes = 0): CompactProgress {
  const b = loadBudget(cfg);
  return {
    running,
    nodes: lastNodes,
    tokensToday: b.tokens,
    budget: cfg.compactBudgetTokens,
    model: cfg.compactModel,
  };
}

async function runBatch(
  cfg: NcliConfig,
  run: CompactRunner,
  cache: Map<string, string>,
  jobs: Job[],
  onProgress?: CompactListener,
): Promise<void> {
  const prompt = jobPrompt(jobs);
  const tokensIn = estimateTokens(prompt);
  onProgress?.(compactSnapshot(cfg, true, jobs.length));
  try {
    const reply = await run(prompt, cfg.compactModel);
    const lines = parseNumbered(reply, jobs.length);
    const tokensOut = estimateTokens(reply);
    bumpBudget(cfg, tokensIn + tokensOut);
    logCall(cfg.dataDir, {
      t: new Date().toISOString(),
      model: cfg.compactModel,
      items: jobs.length,
      tokensIn,
      tokensOut,
      cached: 0,
      skipped: 0,
    });
    jobs.forEach((j, i) => {
      const line = cut(flattenLine(lines[i] ?? j.input.source), j.input.nodeBytes);
      cache.set(j.hash, line);
      persistCache(cfg.dataDir, j.hash, line);
      j.resolve(line);
    });
    onProgress?.(compactSnapshot(cfg, false, jobs.length));
  } catch (err) {
    onProgress?.(compactSnapshot(cfg, false, 0));
    for (const j of jobs) j.reject(err);
  }
}

export function parseNumbered(reply: string, n: number): string[] {
  const lines = reply
    .split("\n")
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
  while (lines.length < n) lines.push(lines[lines.length - 1] ?? "");
  return lines.slice(0, n);
}

export function parseCursorPrint(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["result", "text", "message", "response"]) {
      const v = json[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch {
    const last = trimmed.split("\n").filter(Boolean).at(-1) ?? "";
    try {
      const json = JSON.parse(last) as Record<string, unknown>;
      if (typeof json.result === "string") return json.result;
    } catch {
      return trimmed.split("\n").filter((l) => !l.startsWith("{")).join(" ").trim() || trimmed;
    }
  }
  return flattenLine(trimmed);
}

function defaultCursorRunner(cfg: NcliConfig): CompactRunner {
  return async (prompt, model) => {
    const bin = cfg.cursorBin;
    const proc = Bun.spawn(
      [bin, "--print", "--model", model, "--output-format", "json", "--trust", prompt],
      { stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return parseCursorPrint(text);
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadBudget(cfg: NcliConfig): Budget {
  const path = join(cfg.dataDir, "compact-budget.json");
  if (!existsSync(path)) return { day: today(), tokens: 0, calls: 0 };
  try {
    const b = JSON.parse(readFileSync(path, "utf8")) as Budget;
    if (b.day !== today()) return { day: today(), tokens: 0, calls: 0 };
    return b;
  } catch {
    return { day: today(), tokens: 0, calls: 0 };
  }
}

function bumpBudget(cfg: NcliConfig, tokens: number): void {
  mkdirSync(cfg.dataDir, { recursive: true });
  const b = loadBudget(cfg);
  b.tokens += tokens;
  b.calls += 1;
  writeFileSync(join(cfg.dataDir, "compact-budget.json"), JSON.stringify(b), "utf8");
}

function loadCache(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  const path = join(dir, "compact-cache.jsonl");
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { h: string; t: string };
      map.set(row.h, row.t);
    } catch {
      continue;
    }
  }
  return map;
}

function persistCache(dir: string, h: string, t: string): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "compact-cache.jsonl"), `${JSON.stringify({ h, t })}\n`);
}

function logCall(dir: string, row: CompactLog): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "compact-log.jsonl"), `${JSON.stringify(row)}\n`);
}

function cut(s: string, n: number): string {
  let out = s;
  while (utf8Bytes(out) > n && out.length) out = out.slice(0, -1);
  return out || "…";
}
