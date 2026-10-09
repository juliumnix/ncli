import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrInfo } from "../src/gh/pr";
import {
  activeFileId,
  alignDiagram,
  buildReviewUi,
  changedFunctions,
  classify,
  extractPlan,
  foldContextRuns,
  parseUnifiedDiff,
  toggleReviewed,
  validatePlan,
} from "../src/review/model";
import review from "../views/review";
import { makeHub } from "./helpers";

function fixturePr(): PrInfo {
  const meta = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/gh/pr-482.json"), "utf8")) as PrInfo;
  meta.diff = readFileSync(join(import.meta.dir, "../fixtures/gh/pr-482.diff"), "utf8");
  return meta;
}

test("classify puts core first and db/generated/tests last", () => {
  const paths = [
    "src/billing/discount.ts",
    "src/api/budget.ts",
    "prisma/migrations/001.sql",
    "src/gen/types.gen.ts",
    "src/billing/discount.test.ts",
  ];
  expect(paths.map(classify)).toEqual(["core", "api", "db", "generated", "test"]);
});

test("unified diff has two line-number columns and folds the leading unmodified run", () => {
  const files = parseUnifiedDiff(fixturePr().diff);
  const discount = files["src/billing/discount.ts"];
  expect(discount).toBeDefined();
  expect(discount!.lines[0]).toMatchObject({ kind: "fold", count: 9, oldNo: 1 });
  const calc = files["src/billing/calcTotal.ts"];
  expect(calc).toBeDefined();
  const add = calc!.lines.find((l) => l.kind === "add" && l.text.includes("applyDiscount"));
  expect(add?.newNo).toBeGreaterThan(0);
  expect(add?.oldNo).toBeUndefined();
  const del = calc!.lines.find((l) => l.kind === "del");
  expect(del?.oldNo).toBeGreaterThan(0);
  expect(del?.newNo).toBeUndefined();
});

test("foldContextRuns collapses a long unchanged stretch and keeps short context", () => {
  const short = foldContextRuns(
    [
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1, hunk: 0 },
      { kind: "add", text: "b", newNo: 2, hunk: 0 },
    ],
    8,
  );
  expect(short.map((l) => l.kind)).toEqual(["ctx", "add"]);
  const long = Array.from({ length: 10 }, (_, i) => ({
    kind: "ctx" as const,
    text: `L${i}`,
    oldNo: i + 1,
    newNo: i + 1,
    hunk: 0,
  }));
  const folded = foldContextRuns(long, 8);
  expect(folded).toHaveLength(1);
  expect(folded[0]?.kind).toBe("fold");
  expect(folded[0]?.count).toBe(10);
  expect(folded[0]?.folded).toHaveLength(10);
});

test("activeFileId picks the card with the most viewport overlap", () => {
  const cards = [
    { id: "a.ts", top: 0, bottom: 100 },
    { id: "b.ts", top: 100, bottom: 300 },
    { id: "c.ts", top: 300, bottom: 400 },
  ];
  expect(activeFileId(cards, 120, 280)).toBe("b.ts");
  expect(activeFileId(cards, 0, 50)).toBe("a.ts");
  expect(activeFileId([], 0, 100)).toBeNull();
});

test("invalid agent plan falls back; valid plan maps files to chapters", () => {
  const pr = fixturePr();
  const bad = validatePlan({ chapters: [{ title: "x", files: ["nope.ts"] }] }, pr.files);
  expect(bad).toBeNull();
  const ui = buildReviewUi(pr, { not: "a plan" });
  expect(ui.planSource).toBe("fallback");
  expect(ui.chapters[0]?.kind).toBe("core");
  expect(ui.chapters.at(-1)?.kind).toBe("test");
  const agent = {
    overview: "Plano do agente.",
    approach: ["um", "dois", "três", "quatro"],
    diagram: {
      title: "fluxo",
      additions: 4,
      nodes: [{ id: "a", label: "applyDiscount()", chapter: 1, added: true }],
      edges: [],
    },
    chapters: [
      { title: "Núcleo", body: "desconto", files: ["src/billing/discount.ts", "src/billing/types.ts", "src/billing/calcTotal.ts"] },
      { title: "API", body: "handler", files: ["src/api/budget.ts"] },
    ],
  };
  expect(validatePlan(agent, pr.files)?.chapters.map((c) => c.title)).toEqual(["Núcleo", "API", "Testes: discount.test"]);
  const planned = buildReviewUi(pr, agent);
  expect(planned.planSource).toBe("agent");
  expect(planned.overview).toBe("Plano do agente.");
  expect(planned.chapters[0]?.files.map((f) => f.path)).toEqual([
    "src/billing/discount.ts",
    "src/billing/types.ts",
    "src/billing/calcTotal.ts",
  ]);
});

test("extractPlan reads a fenced json block from agent text", () => {
  const raw = extractPlan('ok\n```json\n{"chapters":[{"title":"A","files":["src/billing/discount.ts"]}]}\n```\n');
  expect(raw && typeof raw === "object" && "chapters" in raw).toBe(true);
});

test("render is a guided review: tabs, file grid, 40/60 guide, no approve/chat trio", async () => {
  const { hub } = await makeHub();
  const rt = await hub.forks.open("review", { pr: "482" });
  const html = review.render!(rt.fork);
  expect(html).toContain("data-tab=\"Overview\"");
  expect(html).toContain("data-tab=\"Guide\"");
  expect(html).toContain("data-tab=\"Diff\"");
  expect(html).toContain("Apply member discount before tax");
  expect(html).toContain("ada");
  expect(html).toContain("#482");
  expect(html).toContain("Files 5");
  expect(html).toContain("rv-grid");
  expect(html).toContain("rv-row");
  expect(html).toContain("Before / after");
  expect(html).toContain("unmodified line");
  expect(html).toContain("Reviewed");
  expect(html).toContain("calcTotal.ts");
  expect(html).toContain("applyDiscount");
  expect(html).not.toContain("sem hunk neste arquivo");
  expect(html).not.toContain(">max()<");
  expect(html).not.toContain("Approve");
  expect(html).not.toContain("Merge");
  expect(html).not.toContain("class=\"trio\"");
  expect(html).toContain('class="ln"');
  const ui = rt.fork.ui as ReturnType<typeof buildReviewUi>;
  expect(ui.chapters[0]?.kind).toBe("core");
  expect(ui.chapters.at(-1)?.kind).toBe("test");
  hub.close();
});

test("Reviewed toggles persist on the chapter", async () => {
  const { hub } = await makeHub();
  const rt = await hub.forks.open("review", { pr: "482" });
  const before = (rt.fork.ui as ReturnType<typeof buildReviewUi>).chapters[0]!;
  expect(before.reviewed).toBe(false);
  await hub.actFork(rt.fork.id, { type: "review-chapter", id: before.id });
  expect((rt.fork.ui as ReturnType<typeof buildReviewUi>).chapters[0]?.reviewed).toBe(true);
  const next = toggleReviewed(rt.fork.ui as ReturnType<typeof buildReviewUi>, "file", "src/billing/discount.ts");
  expect(next.fileState.find((f) => f.path.endsWith("discount.ts"))?.reviewed).toBe(true);
  hub.close();
});

test("diagram nodes are changed functions mapped to the chapter of their file", () => {
  const pr = fixturePr();
  const fns = changedFunctions(pr.diff);
  expect(fns.map((f) => f.name).sort()).toEqual(["applyDiscount", "budgetHandler", "calcTotal"]);
  expect(fns.some((f) => f.name === "max")).toBe(false);

  const ui = buildReviewUi(pr);
  const byLabel = Object.fromEntries(ui.diagram.nodes.map((n) => [n.label, n.chapter]));
  expect(byLabel["calcTotal()"]).toBe(1);
  expect(byLabel["applyDiscount()"]).toBe(1);
  expect(byLabel["budgetHandler()"]).toBe(2);
  expect(ui.diagram.nodes.some((n) => /max\(\)/.test(n.label))).toBe(false);
  expect(ui.chapters[0]?.files.map((f) => f.path)).toContain("src/billing/calcTotal.ts");
  expect(ui.diffs["src/billing/calcTotal.ts"]?.lines.some((l) => l.kind === "add")).toBe(true);

  const garbage = alignDiagram(
    {
      title: "fluxo",
      additions: 4,
      nodes: [
        { id: "max", label: "max()", chapter: 3, added: false },
        { id: "a", label: "calcTotal()", chapter: 3, added: false },
      ],
      edges: [],
    },
    ui.chapters.map((ch) => ({ title: ch.title, body: ch.body, files: ch.files.map((f) => f.path) })),
    pr.diff,
    4,
  );
  expect(garbage.nodes.map((n) => n.label)).toEqual(["calcTotal()"]);
  expect(garbage.nodes[0]?.chapter).toBe(1);
});

test("a file with no hunk is dropped from the chapter and not rendered empty", () => {
  const pr = fixturePr();
  pr.files = [...pr.files, { path: "src/billing/ghost.ts", additions: 6, deletions: 0 }];
  const ui = buildReviewUi(pr, {
    overview: "x",
    approach: ["a", "b", "c", "d"],
    chapters: [{ title: "Núcleo", body: "núcleo", files: ["src/billing/discount.ts", "src/billing/ghost.ts"] }],
  });
  expect(ui.chapters[0]?.files.map((f) => f.path)).toEqual(["src/billing/discount.ts"]);
  expect(ui.diffs["src/billing/ghost.ts"]).toBeUndefined();
});
