import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasCompactDailyBudget, type NcliConfig } from "../config";
import { childEnv } from "../harness/child-env";
import { flattenLine, keepRecent, utf8Bytes } from "../util";
import { cursorCliConfigPath, withUnchangedFile } from "./cli-config";
import { isSdkUnavailable, requireCompactSdkKey, runCursorSdkCompact, type SdkCompactFn } from "./sdk-compact";
import { COMPACT_PROMPT } from "./compact";
import { CompactBudgetPause, CompactDeferred, CompactHold, isProviderLimitMessage, ProviderLimitError } from "./compact-deferred";
import { COMPACT_RULER, COMPACT_TOO_LONG_TRIES } from "./cli-compact";
import type { CompactInput, Compressor } from "./store";

export { CompactBudgetPause, CompactDeferred, CompactHold, ProviderLimitError };

export const CURSOR_COMPACT_PROMPT =
  "One-line memory for NCLI. Output only the line. Keep user words, decisions, ids. If a later item replaces an earlier one, keep the final state and name what it replaced. Drop tool noise.";

export type CompactRunner = (prompt: string, model: string) => Promise<string>;

export interface CompactProgress {
  running: boolean;
  nodes: number;
  done?: number;
  total?: number;
  paused?: "budget" | "limit";
  tokensToday: number;
  budget: number;
  model: string;
  error?: string;
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
  const run = runner ?? defaultCompactRunner(cfg);
  const cache = loadCache(cfg.dataDir);
  const queue: Job[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const batchN = cfg.compactBatch;

  const flush = () => {
    timer = null;
    const taken = queue.splice(0);
    if (!taken.length) return;
    const batches = splitJobsByTokens(taken, {
      maxItems: batchN,
      maxInputTokens: cfg.compactMaxInputTokens,
    });
    void mapLimit(batches, cfg.compactJobs, (jobs) => runBatch(cfg, run, cache, jobs, onProgress));
  };

  const compress: Compressor = async (input) => {
    const hash = nodeHash(input);
    const hit = cache.get(hash);
    if (hit) {
      logCall(cfg.dataDir, { t: new Date().toISOString(), model: cfg.compactModel, items: 1, tokensIn: 0, tokensOut: 0, cached: 1, skipped: 0 });
      return cut(hit, input.nodeBytes);
    }
    const source = input.kind === "merge"
      ? `${input.left ?? ""}\n${input.right ?? ""}`
      : input.source;
    if (estimateTokens(source) <= cfg.compactSkipTokens) {
      logCall(cfg.dataDir, { t: new Date().toISOString(), model: cfg.compactModel, items: 1, tokensIn: 0, tokensOut: 0, cached: 0, skipped: 1 });
      return cut(flattenLine(source), input.nodeBytes);
    }
    if (overDailyBudget(cfg)) throw new CompactBudgetPause();
    return new Promise((resolve, reject) => {
      queue.push({ input, hash, resolve, reject });
      if (queue.length >= batchN) flush();
      else if (!timer) timer = setTimeout(flush, cfg.compactDebounceMs || 2500);
    });
  };
  return compress;
}

export function jobPrompt(jobs: Array<{ input: CompactInput }>): string {
  const chat = jobs[0]?.input.contextLines?.join("\n") ?? "";
  const body = jobs
    .map((j, i) => {
      const ruler = "-".repeat(COMPACT_RULER);
      const step =
        j.input.kind === "leaf"
          ? `Compress:\n<input>\n${j.input.source}\n</input>`
          : `Merge:\n<input>\n${j.input.left}\n${j.input.right}\n</input>`;
      return `### ${i + 1} (max ${j.input.nodeBytes} bytes)\n${ruler}\n${step}`;
    })
    .join("\n\n");
  return `${COMPACT_PROMPT}\n${CURSOR_COMPACT_PROMPT}\n<chat>\n${chat}\n</chat>\nOutput ${jobs.length} lines, numbered 1..${jobs.length}. Nothing else.\n\n${body}`;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const n = Math.max(1, limit);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
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

export function compactSnapshot(
  cfg: NcliConfig,
  running = false,
  lastNodes = 0,
  error?: string,
  paused?: "budget" | "limit",
): CompactProgress {
  const b = loadBudget(cfg);
  return {
    running,
    nodes: lastNodes,
    tokensToday: b.tokens,
    budget: cfg.compactBudgetTokens,
    model: cfg.compactModel,
    ...(error ? { error } : {}),
    ...(paused ? { paused } : {}),
  };
}

async function runBatch(
  cfg: NcliConfig,
  run: CompactRunner,
  cache: Map<string, string>,
  jobs: Job[],
  onProgress?: CompactListener,
): Promise<void> {
  if (overDailyBudget(cfg)) {
    const pause = new CompactBudgetPause();
    onProgress?.(compactSnapshot(cfg, false, 0, undefined, "budget"));
    for (const j of jobs) j.reject(pause);
    return;
  }
  const prompt = jobPrompt(jobs);
  const tokensIn = estimateTokens(prompt);
  onProgress?.(compactSnapshot(cfg, true, jobs.length));
  try {
    let reply = "";
    let lines: string[] = [];
    let ask = prompt;
    for (let tryN = 0; tryN < COMPACT_TOO_LONG_TRIES; tryN++) {
      reply = await run(ask, cfg.compactModel);
      lines = parseNumbered(reply, jobs.length);
      const over = jobs.some((j, i) => {
        const line = flattenLine(lines[i] ?? "");
        return !line || utf8Bytes(line) > j.input.nodeBytes;
      });
      if (!over) break;
      ask = `Too long.\n${prompt}`;
    }
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
      const raw = lines[i];
      const line = raw ? flattenLine(raw) : "";
      if (!line || utf8Bytes(line) > j.input.nodeBytes) {
        j.reject(new CompactDeferred());
        return;
      }
      cache.set(j.hash, line);
      persistCache(cfg.dataDir, j.hash, line);
      j.resolve(line);
    });
    onProgress?.(compactSnapshot(cfg, false, jobs.length));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fail = err instanceof ProviderLimitError || isProviderLimitMessage(msg)
      ? err instanceof ProviderLimitError ? err : new ProviderLimitError(msg)
      : err;
    onProgress?.(compactSnapshot(
      cfg,
      false,
      0,
      msg,
      fail instanceof ProviderLimitError ? "limit" : undefined,
    ));
    for (const j of jobs) j.reject(fail);
  }
}

export function parseNumbered(reply: string, n: number): string[] {
  const byNum = new Map<number, string>();
  for (const raw of reply.split("\n")) {
    const m = raw.match(/^\s*(\d+)[.)]\s*(.*)$/);
    if (!m) continue;
    const idx = Number(m[1]);
    if (idx < 1 || idx > n || byNum.has(idx)) continue;
    const text = m[2].trim();
    if (text) byNum.set(idx, text);
  }
  return Array.from({ length: n }, (_, i) => byNum.get(i + 1) ?? "");
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

export function defaultCompactRunner(
  cfg: NcliConfig,
  deps: { sdk?: SdkCompactFn; home?: string; env?: Record<string, string | undefined> } = {},
): CompactRunner {
  return async (prompt, model) => {
    const home = deps.home ?? homedir();
    const cliConfig = cursorCliConfigPath(home);
    const env = deps.env ?? process.env;
    return withUnchangedFile(cliConfig, async () => {
      const key = requireCompactSdkKey(env);
      if (deps.sdk) return deps.sdk(prompt, model, key);
      try {
        return await runCursorSdkCompact(prompt, model, key, cfg.repo);
      } catch (err) {
        if (!isSdkUnavailable(err)) throw err;
        return sdkUnavailableCliFallback(cfg, prompt, model);
      }
    });
  };
}

async function sdkUnavailableCliFallback(cfg: NcliConfig, prompt: string, model: string): Promise<string> {
  const isolated = join(cfg.dataDir, "compact-home");
  mkdirSync(join(isolated, ".cursor"), { recursive: true });
  const env = childEnv(process.env);
  env.HOME = isolated;
  delete env.CURSOR_API_KEY;
  delete env.NCLI_CURSOR_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  const proc = Bun.spawn(
    [cfg.cursorBin, "--print", "--model", model, "--output-format", "json", "--trust", prompt],
    { stdout: "pipe", stderr: "pipe", env },
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return parseCursorPrint(text);
}

function overDailyBudget(cfg: NcliConfig): boolean {
  if (!hasCompactDailyBudget(cfg.compactBudgetTokens)) return false;
  return loadBudget(cfg).tokens >= cfg.compactBudgetTokens;
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
  return keepRecent(s, n);
}
