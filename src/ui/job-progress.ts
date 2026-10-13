import { importPct } from "../import/progress";
import type { ImportSource } from "../import/types";

export type JobKind = "import" | "compact";
export type JobPhase = "running" | "done" | "error";

export type JobProgress = {
  kind: JobKind;
  phase: JobPhase;
  source?: ImportSource;
  done: number;
  total: number;
  startedAt: number;
  error?: string;
};

const SOURCE_NAME: Record<ImportSource, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

export function jobPct(job: Pick<JobProgress, "done" | "total">): number | null {
  return importPct(job.done, job.total);
}

export function jobEtaMs(job: Pick<JobProgress, "done" | "total" | "startedAt" | "phase">, now: number): number | null {
  if (job.phase !== "running") return null;
  if (job.startedAt <= 0 || job.done < 2 || job.total <= job.done) return null;
  const elapsed = now - job.startedAt;
  if (elapsed < 800) return null;
  const rate = job.done / elapsed;
  if (rate <= 0) return null;
  return Math.round((job.total - job.done) / rate);
}

export function jobEtaLabel(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 5000) return "~alguns segundos";
  if (ms < 60_000) return `~${Math.round(ms / 1000)}s`;
  const min = Math.max(1, Math.round(ms / 60_000));
  return min === 1 ? "~1 min" : `~${min} min`;
}

export function jobStage(job: JobProgress): string {
  if (job.kind === "import") {
    const name = job.source ? SOURCE_NAME[job.source] : "CLI";
    switch (job.phase) {
      case "running":
        return `Lendo seu histórico do ${name}`;
      case "done":
        return `Histórico do ${name} pronto`;
      case "error":
        return `Não deu pra ler o histórico do ${name}`;
      default: {
        const _n: never = job.phase;
        return _n;
      }
    }
  }
  switch (job.phase) {
    case "running":
      return "Organizando a memória";
    case "done":
      return "Memória organizada";
    case "error":
      return "Não deu pra organizar a memória";
    default: {
      const _n: never = job.phase;
      return _n;
    }
  }
}

export function jobCounts(job: JobProgress): string {
  if (job.phase !== "running" || job.total <= 0) return "";
  if (job.kind === "import") {
    const noun = job.total === 1 ? "conversa" : "conversas";
    return `${job.done} de ${job.total} ${noun}`;
  }
  return "";
}

export function jobLine(job: JobProgress, now = Date.now()): string {
  const stage = jobStage(job);
  if (job.phase === "error") return stage;
  if (job.phase === "done") return stage;
  const counts = jobCounts(job);
  const pct = jobPct(job);
  const eta = jobEtaLabel(jobEtaMs(job, now));
  const bits = [stage];
  if (job.kind === "import" && counts) bits.push(counts);
  else if (pct !== null) bits.push(`${pct}%`);
  else if (counts) bits.push(counts);
  if (eta) bits.push(eta);
  return bits.join(" · ");
}

export function jobMeta(job: JobProgress, now = Date.now()): string {
  if (job.phase !== "running") return "";
  const pct = jobPct(job);
  const eta = jobEtaLabel(jobEtaMs(job, now));
  const bits: string[] = [];
  if (job.kind === "import" && pct !== null) bits.push(`${pct}%`);
  if (eta) bits.push(eta);
  return bits.join(" · ");
}
