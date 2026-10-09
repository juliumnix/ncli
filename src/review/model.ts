import type { PrFile, PrInfo } from "../gh/pr";

export type ChapterKind = "core" | "api" | "glue" | "db" | "generated" | "test";

export const KIND_ORDER: ChapterKind[] = ["core", "api", "glue", "db", "generated", "test"];

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "fold";
  text: string;
  oldNo?: number;
  newNo?: number;
  hunk: number;
  count?: number;
  folded?: DiffLine[];
}

export interface FileDiff {
  path: string;
  lines: DiffLine[];
  hunkCount: number;
}

export interface DiagramNode {
  id: string;
  label: string;
  chapter: number;
  added: boolean;
}

export interface ReviewPlan {
  overview: string;
  approach: string[];
  diagram: { title: string; additions: number; nodes: DiagramNode[]; edges: Array<[string, string]> };
  chapters: Array<{ title: string; body: string; files: string[] }>;
}

export interface ReviewChapter {
  id: string;
  n: number;
  total: number;
  title: string;
  kind: ChapterKind;
  body: string;
  files: PrFile[];
  reviewed: boolean;
}

export interface ReviewFileState {
  path: string;
  reviewed: boolean;
}

export interface ReviewUi {
  kind: "review";
  tab: "Overview" | "Guide" | "Diff";
  pr: {
    number: number;
    title: string;
    author: string;
    body: string;
    additions: number;
    deletions: number;
    files: PrFile[];
    diff: string;
  };
  overview: string;
  approach: string[];
  diagram: ReviewPlan["diagram"];
  chapters: ReviewChapter[];
  fileState: ReviewFileState[];
  diffs: Record<string, FileDiff>;
  activeFile: string;
  planSource: "agent" | "fallback";
}

export function classify(path: string): ChapterKind {
  const p = path.replaceAll("\\", "/");
  const lower = p.toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(lower) || /\.(test|spec)\./.test(lower)) return "test";
  if (/(^|\/)(migrations?|prisma|drizzle)(\/|$)/.test(lower) || /\.sql$/.test(lower)) return "db";
  if (
    /(^|\/)(generated|__generated__|gen|dist|vendor)\//.test(lower) ||
    /\.gen\./.test(lower) ||
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock)$/.test(lower)
  ) {
    return "generated";
  }
  if (/(route|router|api|endpoint|handler|controller)/i.test(p)) return "api";
  if (/(readme|\.md$|docs\/|config\.)/i.test(p)) return "glue";
  return "core";
}

export function splitPath(path: string): { name: string; dir: string } {
  const norm = path.replaceAll("\\", "/");
  const i = norm.lastIndexOf("/");
  if (i < 0) return { name: norm, dir: "" };
  return { name: norm.slice(i + 1), dir: norm.slice(0, i + 1) };
}

export function parseUnifiedDiff(diff: string): Record<string, FileDiff> {
  const out: Record<string, FileDiff> = {};
  if (!diff.trim()) return out;
  const chunks = diff.split(/^diff --git /m).slice(1);
  for (const chunk of chunks) {
    const header = chunk.match(/^a\/(.+?) b\/(.+)$/m);
    const path = (header?.[2] ?? header?.[1] ?? "").trim();
    if (!path) continue;
    out[path] = parseFileChunk(path, chunk);
  }
  return out;
}

function parseFileChunk(path: string, chunk: string): FileDiff {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let hunk = -1;
  let prevOldEnd = 1;
  let prevNewEnd = 1;
  for (const raw of chunk.split("\n")) {
    const mark = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (mark) {
      const nextOld = Number(mark[1]);
      const nextNew = Number(mark[2]);
      const skipOld = nextOld - prevOldEnd;
      if (hunk >= 0 && skipOld > 0) {
        lines.push({
          kind: "fold",
          text: "",
          hunk,
          count: skipOld,
          oldNo: prevOldEnd,
          newNo: prevNewEnd,
        });
      } else if (hunk < 0 && nextOld > 1) {
        lines.push({
          kind: "fold",
          text: "",
          hunk: 0,
          count: nextOld - 1,
          oldNo: 1,
          newNo: 1,
        });
      }
      hunk += 1;
      oldNo = nextOld;
      newNo = nextNew;
      continue;
    }
    if (hunk < 0) continue;
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ") || raw.startsWith("diff ")) {
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), newNo, hunk });
      newNo += 1;
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldNo, hunk });
      oldNo += 1;
    } else if (raw.startsWith("\\")) {
      continue;
    } else {
      const text = raw.startsWith(" ") ? raw.slice(1) : raw;
      lines.push({ kind: "ctx", text, oldNo, newNo, hunk });
      oldNo += 1;
      newNo += 1;
    }
    prevOldEnd = oldNo;
    prevNewEnd = newNo;
  }
  return { path, lines: foldContextRuns(lines), hunkCount: hunk + 1 };
}

export function foldContextRuns(lines: DiffLine[], min = 8): DiffLine[] {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length >= min) {
      out.push({
        kind: "fold",
        text: "",
        hunk: run[0]!.hunk,
        count: run.length,
        oldNo: run[0]!.oldNo,
        newNo: run[0]!.newNo,
        folded: run,
      });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const line of lines) {
    if (line.kind === "ctx") {
      run.push(line);
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
}

export function activeFileId(
  cards: Array<{ id: string; top: number; bottom: number }>,
  viewTop: number,
  viewBottom: number,
): string | null {
  let best: { id: string; overlap: number } | null = null;
  for (const card of cards) {
    const overlap = Math.max(0, Math.min(card.bottom, viewBottom) - Math.max(card.top, viewTop));
    if (!best || overlap > best.overlap) best = { id: card.id, overlap };
  }
  if (best && best.overlap > 0) return best.id;
  return cards[0]?.id ?? null;
}

export function extractPlan(text: string): unknown | null {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  const raw = fence?.[1] ?? text.match(/(\{[\s\S]*"chapters"[\s\S]*\})/)?.[1];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function validatePlan(raw: unknown, files: PrFile[]): ReviewPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.chapters) || !o.chapters.length) return null;
  const known = new Set(files.map((f) => f.path));
  const chapters: ReviewPlan["chapters"] = [];
  const used = new Set<string>();
  for (const ch of o.chapters) {
    if (!ch || typeof ch !== "object") continue;
    const c = ch as Record<string, unknown>;
    const paths = Array.isArray(c.files) ? c.files.map((p) => String(p)).filter((p) => known.has(p)) : [];
    if (!paths.length) continue;
    paths.forEach((p) => used.add(p));
    chapters.push({
      title: String(c.title ?? splitPath(paths[0]!).name),
      body: String(c.body ?? ""),
      files: paths,
    });
  }
  if (!chapters.length) return null;
  const leftover = files.filter((f) => !used.has(f.path));
  if (leftover.length) {
    const grouped = groupByKind(leftover);
    for (const g of grouped) {
      chapters.push({
        title: titleFor(g.files, g.kind),
        body: g.body,
        files: g.files.map((f) => f.path),
      });
    }
  }
  const diagram = parseDiagram(o.diagram);
  const approach = Array.isArray(o.approach)
    ? o.approach.map((s) => String(s)).filter(Boolean).slice(0, 6)
    : [];
  return {
    overview: String(o.overview ?? ""),
    approach: approach.length ? approach : defaultApproach(),
    diagram,
    chapters,
  };
}

function parseDiagram(raw: unknown): ReviewPlan["diagram"] {
  if (!raw || typeof raw !== "object") return emptyDiagram();
  const d = raw as Record<string, unknown>;
  const nodes: DiagramNode[] = [];
  if (Array.isArray(d.nodes)) {
    d.nodes.forEach((n, i) => {
      if (!n || typeof n !== "object") return;
      const node = n as Record<string, unknown>;
      nodes.push({
        id: String(node.id ?? `n${i + 1}`),
        label: String(node.label ?? node.id ?? `n${i + 1}`),
        chapter: Number(node.chapter ?? 0),
        added: Boolean(node.added),
      });
    });
  }
  const edges: Array<[string, string]> = [];
  if (Array.isArray(d.edges)) {
    for (const e of d.edges) {
      if (Array.isArray(e) && e.length >= 2) edges.push([String(e[0]), String(e[1])]);
      else if (e && typeof e === "object" && "from" in e && "to" in e) {
        const row = e as { from: unknown; to: unknown };
        edges.push([String(row.from), String(row.to)]);
      }
    }
  }
  return {
    title: String(d.title ?? "Before / after"),
    additions: Number(d.additions ?? 0) || 0,
    nodes,
    edges,
  };
}

function emptyDiagram(): ReviewPlan["diagram"] {
  return { title: "Before / after", additions: 0, nodes: [], edges: [] };
}

export function fileChapterMap(chapters: Array<{ files: string[] }>): Map<string, number> {
  const map = new Map<string, number>();
  chapters.forEach((ch, i) => {
    for (const path of ch.files) map.set(path, i + 1);
  });
  return map;
}

const NOT_A_FN = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "typeof",
  "await",
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "Promise",
  "JSON",
  "console",
  "expect",
  "test",
  "describe",
  "it",
  "max",
  "min",
  "abs",
  "floor",
  "ceil",
  "round",
  "parse",
]);

const FN_DEF =
  /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/

export interface ChangedFn {
  name: string;
  path: string;
  added: boolean;
}

export function changedFunctions(diff: string): ChangedFn[] {
  const found: ChangedFn[] = [];
  const seen = new Set<string>();
  let path = "";
  let current: { name: string; added: boolean } | undefined;
  let dirty = false;
  const flush = () => {
    if (path && current && dirty) pushFn(found, seen, { ...current, path });
  };
  for (const raw of diff.split("\n")) {
    const file = raw.match(/^diff --git a\/.+ b\/(.+)$/);
    if (file) {
      flush();
      path = file[1]!.trim();
      current = undefined;
      dirty = false;
      continue;
    }
    const hunk = raw.match(/^@@ [^@]+ @@\s*(.*)$/);
    if (hunk) {
      flush();
      dirty = false;
      const name = nameFromDef(hunk[1] ?? "");
      current = name ? { name, added: false } : undefined;
      continue;
    }
    if (!path || raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ")) continue;
    const body = raw.startsWith("+") || raw.startsWith("-") || raw.startsWith(" ") ? raw.slice(1) : raw;
    const name = nameFromDef(body);
    if (name) {
      if (raw.startsWith("+")) {
        pushFn(found, seen, { name, path, added: true });
        current = { name, added: true };
      } else {
        current = { name, added: false };
      }
    }
    if (raw.startsWith("+") || raw.startsWith("-")) dirty = true;
  }
  flush();
  return found;
}

function nameFromDef(line: string): string | undefined {
  const m = line.match(FN_DEF);
  const name = m?.[1] || m?.[2];
  if (!name || name.length < 2 || NOT_A_FN.has(name)) return undefined;
  return name;
}

function pushFn(found: ChangedFn[], seen: Set<string>, fn: ChangedFn): void {
  const key = `${fn.path}#${fn.name}`;
  if (seen.has(key)) return;
  seen.add(key);
  found.push(fn);
}

export function alignDiagram(
  raw: ReviewPlan["diagram"],
  chapters: ReviewPlan["chapters"],
  diff: string,
  additions: number,
): ReviewPlan["diagram"] {
  const map = fileChapterMap(chapters);
  const changed = changedFunctions(diff);
  const truth: DiagramNode[] = [];
  const byName = new Map<string, DiagramNode>();
  for (const fn of changed) {
    const chapter = map.get(fn.path);
    if (!chapter) continue;
    const node: DiagramNode = {
      id: fn.name,
      label: `${fn.name}()`,
      chapter,
      added: fn.added,
    };
    truth.push(node);
    if (!byName.has(fn.name)) byName.set(fn.name, node);
  }
  const picked: DiagramNode[] = [];
  for (const n of raw.nodes) {
    const name = String(n.label || n.id).replace(/\(\)$/, "");
    const real = byName.get(name);
    if (!real) continue;
    picked.push({ ...real, id: n.id || real.id, added: n.added || real.added });
  }
  const nodes = picked.length ? picked : truth;
  const ids = new Set(nodes.map((n) => n.id));
  let edges = raw.edges.filter(([a, b]) => ids.has(a) && ids.has(b));
  if (!edges.length) {
    for (let i = 0; i < nodes.length - 1; i++) edges.push([nodes[i]!.id, nodes[i + 1]!.id]);
  }
  return {
    title: raw.title || "Before / after",
    additions: raw.additions || additions,
    nodes,
    edges,
  };
}

export function hasHunk(diff: FileDiff | undefined): boolean {
  if (!diff || diff.hunkCount <= 0) return false;
  return diff.lines.some((l) => l.kind === "add" || l.kind === "del");
}

export function chapterFiles(paths: string[], files: PrFile[], diffs: Record<string, FileDiff>): PrFile[] {
  return paths
    .map((p) => files.find((f) => f.path === p))
    .filter((f): f is PrFile => Boolean(f) && hasHunk(diffs[f.path]));
}

export function fallbackPlan(pr: PrInfo): ReviewPlan {
  const files = pr.files?.length ? pr.files : filesFromDiff(pr.diff);
  const grouped = groupByKind(files);
  const chapters = grouped.map((g) => ({
    title: titleFor(g.files, g.kind),
    body: g.body,
    files: g.files.map((f) => f.path),
  }));
  const overview =
    (pr.body ?? "").split("\n").map((l) => l.trim()).find(Boolean) ||
    pr.title ||
    "Mudança no núcleo, depois API, testes por último.";
  return {
    overview,
    approach: defaultApproach(),
    diagram: emptyDiagram(),
    chapters,
  };
}

function groupByKind(files: PrFile[]): Array<{ kind: ChapterKind; files: PrFile[]; body: string }> {
  const buckets = new Map<string, { kind: ChapterKind; files: PrFile[] }>();
  for (const file of files) {
    const kind = classify(file.path);
    const dir = splitPath(file.path).dir;
    const key = `${KIND_ORDER.indexOf(kind)}|${kind}|${dir}`;
    const bucket = buckets.get(key) ?? { kind, files: [] };
    bucket.files.push(file);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, g]) => ({
      kind: g.kind,
      files: g.files,
      body: blurb(g.kind, g.files),
    }));
}

function titleFor(files: PrFile[], kind: ChapterKind): string {
  if (files.some((f) => /discount\.ts$/.test(f.path))) return "Member discount before tax";
  const name = splitPath(files[0]?.path ?? "change").name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
  switch (kind) {
    case "core":
      return name;
    case "api":
      return `Endpoint: ${name}`;
    case "test":
      return `Testes: ${name}`;
    case "db":
      return `Banco: ${name}`;
    case "generated":
      return `Gerado: ${name}`;
    case "glue":
      return `Glue: ${name}`;
    default: {
      const _n: never = kind;
      return String(_n);
    }
  }
}

function blurb(kind: ChapterKind, files: PrFile[]): string {
  const list = files.map((f) => splitPath(f.path).name).join(", ");
  switch (kind) {
    case "core":
      return `Mudança de núcleo em ${list}. É o comportamento que o resto do PR assume.`;
    case "api":
      return `Superfície de API em ${list}. Confira contratos e o que chega no núcleo.`;
    case "test":
      return `Cobertura em ${list}. Vem por último: o núcleo já deve estar claro.`;
    case "db":
      return `Esquema ou migração em ${list}.`;
    case "generated":
      return `Arquivo gerado em ${list}. Olhe por último.`;
    case "glue":
      return `Ajuste auxiliar em ${list}.`;
    default: {
      const _n: never = kind;
      return String(_n);
    }
  }
}

function defaultApproach(): string[] {
  return [
    "Ler o núcleo da mudança e o que passa a ser verdade.",
    "Conferir tipos, helpers e o fluxo before/after.",
    "Ver a superfície de API ou I/O que alimenta o núcleo.",
    "Fechar com testes, gerados e banco, por último.",
  ];
}

function filesFromDiff(diff: string): PrFile[] {
  const paths = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) paths.add(m[2]);
  return [...paths].map((path) => ({ path, additions: 0, deletions: 0 }));
}

export function buildReviewUi(pr: PrInfo, agentRaw?: unknown): ReviewUi {
  const allFiles = pr.files?.length ? pr.files : filesFromDiff(pr.diff);
  const diffs = parseUnifiedDiff(pr.diff);
  const files = allFiles.filter((f) => hasHunk(diffs[f.path]));
  const agent = validatePlan(agentRaw, files);
  const plan = agent ?? fallbackPlan({ ...pr, files });
  const draft = plan.chapters
    .map((ch) => ({
      ...ch,
      files: chapterFiles(ch.files, files, diffs).map((f) => f.path),
    }))
    .filter((ch) => ch.files.length);
  const total = Math.max(draft.length, 1);
  const chapters: ReviewChapter[] = draft.map((ch, i) => {
    const mapped = chapterFiles(ch.files, files, diffs);
    const kind = classify(mapped[0]?.path ?? ch.files[0] ?? "a");
    return {
      id: `ch-${i + 1}`,
      n: i + 1,
      total,
      title: ch.title,
      kind,
      body: ch.body,
      files: mapped,
      reviewed: false,
    };
  });
  const fileState = allFiles.map((f) => ({ path: f.path, reviewed: false }));
  const additions = pr.additions ?? allFiles.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = pr.deletions ?? allFiles.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const diagram = alignDiagram(plan.diagram, draft, pr.diff ?? "", additions);
  return {
    kind: "review",
    tab: "Guide",
    pr: {
      number: pr.number,
      title: pr.title,
      author: authorOf(pr),
      body: pr.body ?? "",
      additions,
      deletions,
      files: allFiles,
      diff: pr.diff ?? "",
    },
    overview: plan.overview,
    approach: plan.approach,
    diagram,
    chapters,
    fileState,
    diffs,
    activeFile: chapters[0]?.files[0]?.path ?? files[0]?.path ?? "",
    planSource: agent ? "agent" : "fallback",
  };
}

function authorOf(pr: PrInfo): string {
  if (typeof pr.author === "string" && pr.author) return pr.author;
  if (pr.author && typeof pr.author === "object" && "login" in pr.author) {
    return String((pr.author as { login: string }).login);
  }
  return "unknown";
}

export function toggleReviewed(ui: ReviewUi, kind: "chapter" | "file", id: string): ReviewUi {
  const next: ReviewUi = structuredClone(ui);
  if (kind === "chapter") {
    const ch = next.chapters.find((c) => c.id === id || String(c.n) === id);
    if (ch) ch.reviewed = !ch.reviewed;
  } else {
    const f = next.fileState.find((s) => s.path === id);
    if (f) f.reviewed = !f.reviewed;
  }
  return next;
}
