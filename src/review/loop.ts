import type { PrInfo } from "../gh/pr";
import { buildReviewUi, type FindingStatus, type ReviewFinding, type ReviewUi } from "./model";

export function findingsFromRisks(risks: ReviewRisk[]): ReviewFinding[] {
  return risks.map((r, i) => ({
    id: r.id || `f-${i + 1}`,
    severity: r.severity,
    text: r.text,
    path: r.path,
    line: r.line,
    chapter: r.chapter,
    status: "open",
  }));
}

export function addComment(ui: ReviewUi, path: string, line: number, body: string): ReviewUi {
  const text = body.trim();
  if (!text || !path || !Number.isFinite(line) || line < 1) return ui;
  const next = structuredClone(ui);
  next.pending.push({
    id: `c-${next.pending.length + 1}-${line}`,
    path,
    line,
    body: text,
  });
  return next;
}

export function sendComments(ui: ReviewUi): { ui: ReviewUi; ask: string } {
  const next = structuredClone(ui);
  const batch = next.pending;
  next.pending = [];
  const ask = [
    "Comentários em lote neste PR. Responda cada um e proponha o patch.",
    ...batch.map((c) => `${c.path}:${c.line} — ${c.body}`),
  ].join("\n");
  return { ui: next, ask };
}

export function setFindingStatus(ui: ReviewUi, id: string, status: FindingStatus): ReviewUi {
  const next = structuredClone(ui);
  const hit = next.findings.find((f) => f.id === id);
  if (hit) hit.status = status;
  return next;
}

export function findingsFence(findings: ReviewFinding[]): string {
  const rows = findings
    .map((f) => {
      const loc = f.line ? `${f.path}:${f.line}` : f.path;
      return `<tr data-finding="${escape(f.id)}"><td>${escape(f.status)}</td><td>${escape(f.severity)}</td><td>${escape(f.text)}</td><td>${escape(loc)}</td></tr>`;
    })
    .join("");
  return "```ncli ui\n" +
    `<section data-findings="1"><h2>Findings</h2><table>${rows}</table></section>\n` +
    "```";
}

export function applyRereview(prev: ReviewUi, pr: PrInfo): ReviewUi {
  const next = buildReviewUi(pr);
  next.fileState = next.fileState.map((f) => ({
    ...f,
    reviewed: prev.fileState.find((p) => p.path === f.path)?.reviewed ?? false,
  }));
  next.chapters.forEach((ch, i) => {
    ch.reviewed = prev.chapters[i]?.reviewed ?? false;
  });
  const incoming = findingsFromRisks(next.risks);
  next.findings = incoming.length ? mergeFindings(prev.findings, incoming) : prev.findings;
  next.pending = prev.pending;
  next.head = pr.headOid ?? prev.head;
  next.prState = pr.state ?? prev.prState;
  next.previousHead = prev.head;
  return next;
}

export function mergeFindings(prev: ReviewFinding[], incoming: ReviewFinding[]): ReviewFinding[] {
  const byKey = new Map(prev.map((f) => [findingKey(f), f]));
  return incoming.map((f) => {
    const old = byKey.get(findingKey(f));
    return old ? { ...f, id: old.id, status: old.status } : f;
  });
}

export function findingKey(f: Pick<ReviewFinding, "path" | "text">): string {
  return `${f.path}\0${f.text}`;
}

export function commentId(raw: string | undefined): { path: string; line: number } | undefined {
  if (!raw) return undefined;
  const cut = raw.lastIndexOf(":");
  if (cut <= 0) return undefined;
  const line = Number(raw.slice(cut + 1));
  if (!Number.isFinite(line) || line < 1) return undefined;
  return { path: raw.slice(0, cut), line };
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
