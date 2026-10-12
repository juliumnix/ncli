import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Memory, mockCompressor, type Compressor } from "../../src/memory/store";
import { generateTranscript } from "./generator";
import type { EvalAggregate, EvalReport, MetricStats, Needle, NeedleReport } from "./types";

export interface EvalOpts {
  n?: number;
  seed?: number;
  viewBytes?: number;
  nodeBytes?: number;
  dir: string;
  compressor?: Compressor;
  label?: string;
}

const TOKEN_RE = /[A-Z][A-Z0-9_]{7,}|\b\d{3,}\b|\/[\w./-]+|[a-z]+(?:[ -][a-z0-9]+){1,3}/g;

function hopTo(mem: Memory, id: number): { hops: number; reached: boolean } {
  const cover = mem.view.find((p) => p.start <= id && id < p.start + p.n);
  if (!cover) return { hops: 0, reached: false };
  let start = cover.start;
  let n = cover.n;
  let hops = 0;
  while (n > 1) {
    const r = mem.zoom(start, n);
    hops += 1;
    if (!r.ok) return { hops, reached: false };
    const mid = start + n / 2;
    if (id >= mid) start = mid;
    n = n / 2;
  }
  const leaf = mem.zoom(id, 1);
  return { hops, reached: leaf.ok };
}

function levelHits(mem: Memory, needle: Needle): Record<string, boolean> {
  const hits: Record<string, boolean> = {};
  const i = needle.messageIndex;
  for (let l = 0; 2 ** l <= mem.T; l++) {
    const idx = Math.floor(i / 2 ** l);
    const node = mem.nodeOf(l, idx);
    const text = node?.text ?? "";
    hits[String(l)] = needle.tokens.some((tok) => text.includes(tok));
  }
  return hits;
}

function inventedCount(mem: Memory): number {
  let bad = 0;
  for (const [key, node] of mem.nodes) {
    const [lRaw, iRaw] = key.split(":");
    const l = Number(lRaw);
    const i = Number(iRaw);
    const start = i * 2 ** l;
    const end = Math.min(start + 2 ** l, mem.T);
    const source = mem.log.slice(start, end).map((m) => m.text).join("\n");
    const tokens = node.text.match(TOKEN_RE) ?? [];
    for (const tok of tokens) {
      if (!source.includes(tok)) bad += 1;
    }
  }
  return bad;
}

function leafText(mem: Memory, id: number): string {
  if (id < 0) return "";
  const r = mem.zoom(id, 1);
  return r.ok ? r.lines.join("\n") : "";
}

export async function runMemoryEval(opts: EvalOpts): Promise<EvalReport> {
  const n = opts.n ?? 300;
  const seed = opts.seed ?? 1;
  const viewBytes = opts.viewBytes ?? 2500;
  const nodeBytes = opts.nodeBytes ?? 280;
  const transcript = generateTranscript(seed, n);
  let compactCalls = 0;
  const inner = opts.compressor ?? mockCompressor();
  const compressor: Compressor = async (input) => {
    compactCalls += 1;
    return inner(input);
  };
  const mem = new Memory({
    dir: opts.dir,
    nodeBytes,
    viewBytes,
    compressor,
  });
  for (const line of transcript.lines) {
    mem.append({ kind: line.kind, text: line.text });
  }
  const settled = await mem.settle(30_000);
  await mem.pump();
  const view = mem.renderView();
  const needles: NeedleReport[] = transcript.needles.map((needle) => {
    const inLog = mem.log.some((m) => needle.tokens.some((tok) => m.text.includes(tok)));
    const inView = needle.tokens.some((tok) => view.includes(tok));
    const hop = inLog ? hopTo(mem, needle.messageIndex) : { hops: null as number | null, reached: false };
    const leaf = leafText(mem, needle.messageIndex);
    return {
      id: needle.id,
      type: needle.type,
      inLog,
      inView,
      hops: hop.hops,
      reachedLeaf: hop.reached,
      answerInLeaf: needle.answer.length > 0 && leaf.includes(needle.answer),
      answerInView: needle.answer.length > 0 && view.includes(needle.answer),
      levelHits: inLog ? levelHits(mem, needle) : {},
    };
  });
  const levels = new Set<string>();
  for (const nrep of needles) for (const l of Object.keys(nrep.levelHits)) levels.add(l);
  const recallAtLevel: Record<string, number> = {};
  for (const l of [...levels].sort((a, b) => Number(a) - Number(b))) {
    const scored = needles.filter((nrep) => nrep.inLog && nrep.id !== "space");
    const hit = scored.filter((nrep) => nrep.levelHits[l]).length;
    recallAtLevel[l] = scored.length ? hit / scored.length : 0;
  }
  const scored = needles.filter((nrep) => nrep.id !== "space");
  const viewPresence = scored.length ? scored.filter((nrep) => nrep.inView).length / scored.length : 0;
  const logNeedles = scored.filter((nrep) => nrep.inLog);
  const reachability = logNeedles.length ? logNeedles.filter((nrep) => nrep.reachedLeaf).length / logNeedles.length : 0;
  return {
    at: new Date().toISOString(),
    seed,
    n,
    compressor: opts.label ?? "mock",
    viewBytes,
    nodeBytes,
    needles,
    recallAtLevel,
    viewPresence,
    reachability,
    invented: inventedCount(mem),
    compactCalls,
    settled,
  };
}

export async function runMemoryEvalSeeds(opts: EvalOpts & { seeds: number[] }): Promise<EvalAggregate> {
  const reports: EvalReport[] = [];
  for (const seed of opts.seeds) {
    reports.push(await runMemoryEval({
      ...opts,
      seed,
      dir: join(opts.dir, `s${seed}`),
    }));
  }
  return {
    seeds: opts.seeds,
    n: opts.n ?? 300,
    compressor: opts.label ?? "mock",
    viewPresence: stats(reports.map((r) => r.viewPresence)),
    reachability: stats(reports.map((r) => r.reachability)),
    invented: stats(reports.map((r) => r.invented)),
    compactCalls: stats(reports.map((r) => r.compactCalls)),
    reports,
  };
}

export function stats(values: number[]): MetricStats {
  if (!values.length) return { mean: 0, stddev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, stddev: Math.sqrt(variance) };
}

export function formatEvalTable(report: EvalReport): string {
  const rows = [
    `memory:eval n=${report.n} seed=${report.seed} compressor=${report.compressor} settled=${report.settled}`,
    `view ${report.viewBytes}B · node ${report.nodeBytes}B · compactCalls ${report.compactCalls} · invented ${report.invented}`,
    `viewPresence ${(report.viewPresence * 100).toFixed(1)}% · reachability ${(report.reachability * 100).toFixed(1)}%`,
    `recall@level ${Object.entries(report.recallAtLevel).map(([l, v]) => `l${l}=${(v * 100).toFixed(0)}%`).join(" ")}`,
    ...report.needles.map((n) => `  ${n.id} log=${n.inLog} view=${n.inView} leaf=${n.reachedLeaf} answer=${n.answerInLeaf} hops=${n.hops ?? "-"}`),
  ];
  return rows.join("\n");
}

export function formatEvalAggregate(agg: EvalAggregate): string {
  const pct = (s: MetricStats) => `${(s.mean * 100).toFixed(1)}% ± ${(s.stddev * 100).toFixed(1)}`;
  return [
    `memory:eval n=${agg.n} seeds=${agg.seeds.join(",")} compressor=${agg.compressor}`,
    `viewPresence ${pct(agg.viewPresence)} · reachability ${pct(agg.reachability)}`,
    `invented ${agg.invented.mean.toFixed(2)} ± ${agg.invented.stddev.toFixed(2)} · compactCalls ${agg.compactCalls.mean.toFixed(1)} ± ${agg.compactCalls.stddev.toFixed(1)}`,
  ].join("\n");
}

export function writeEvalReport(report: EvalReport, dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

export function fakeCursorRunner(prompt: string): string {
  const blocks = [...prompt.matchAll(/<input>\n([\s\S]*?)\n<\/input>/g)].map((m) => m[1] ?? "");
  return blocks.map((src, i) => {
    const kept = (src.match(TOKEN_RE) ?? []).slice(0, 8).join(" ");
    return `${i + 1}. ${kept || src.slice(0, 80)}`;
  }).join("\n");
}
