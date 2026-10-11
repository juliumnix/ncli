import { expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { join } from "node:path";
import type { ReviewUi } from "../src/review/model";
import { addComment, applyRereview, findingsFence, sendComments, setFindingStatus } from "../src/review/loop";
import { buildReviewUi } from "../src/review/model";
import review from "../views/review";
import { makeHub } from "./helpers";
import type { PrInfo } from "../src/gh/pr";
import { readFileSync } from "node:fs";

function fixturePr(): PrInfo {
  const meta = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/gh/pr-482.json"), "utf8")) as PrInfo;
  meta.diff = readFileSync(join(import.meta.dir, "../fixtures/gh/pr-482.diff"), "utf8");
  return meta;
}

test("batch comments become one ask prompt and clear the pending list", () => {
  const ui = buildReviewUi(fixturePr());
  const one = addComment(ui, "src/billing/calcTotal.ts", 4, "guest ainda passa?");
  const two = addComment(one, "src/billing/discount.ts", 11, "falta teste de overflow");
  expect(two.pending).toHaveLength(2);
  const sent = sendComments(two);
  expect(sent.ui.pending).toEqual([]);
  expect(sent.ask).toContain("src/billing/calcTotal.ts:4 — guest ainda passa?");
  expect(sent.ask).toContain("src/billing/discount.ts:11 — falta teste de overflow");
});

test("finding triage stays on the spark and the fence lists status", () => {
  const ui = buildReviewUi(fixturePr(), {
    overview: "x",
    summary: "y",
    risks: [
      { id: "guest-gate", severity: "high", text: "guest gate", path: "src/billing/calcTotal.ts", line: 4 },
    ],
    approach: ["a"],
    chapters: [{ title: "Núcleo", body: "n", files: ["src/billing/calcTotal.ts"] }],
  });
  expect(ui.findings[0]?.status).toBe("open");
  const next = setFindingStatus(ui, "guest-gate", "resolved");
  expect(next.findings[0]?.status).toBe("resolved");
  expect(findingsFence(next.findings)).toContain("```ncli ui");
  expect(findingsFence(next.findings)).toContain("resolved");
  expect(findingsFence(next.findings)).toContain("guest gate");
});

test("rereview keeps triage and records the previous head", () => {
  const pr = fixturePr();
  const ui = buildReviewUi(pr, {
    overview: "x",
    summary: "y",
    risks: [{ id: "guest-gate", severity: "high", text: "guest gate", path: "src/billing/calcTotal.ts", line: 4 }],
    approach: ["a"],
    chapters: [{ title: "Núcleo", body: "n", files: ["src/billing/calcTotal.ts"] }],
  });
  const triaged = setFindingStatus(ui, "guest-gate", "irrelevant");
  const later = { ...pr, headOid: "ccc3333newhead0000000000000000000003" };
  const next = applyRereview(triaged, later);
  expect(next.previousHead).toBe(pr.headOid);
  expect(next.head).toBe("ccc3333newhead0000000000000000000003");
  expect(next.findings.find((f) => f.id === "guest-gate")?.status).toBe("irrelevant");
});

test("hub comment-send asks the spark seat and finding act updates the ui", async () => {
  const { hub } = await makeHub();
  const rt = await hub.sparks.open("review", { pr: "482" });
  const planned = review.onEvent?.(rt.spark, {
    type: "done",
    text: `\`\`\`json\n${JSON.stringify({
      overview: "o",
      summary: "s",
      risks: [{ id: "guest-gate", severity: "high", text: "guest gate", path: "src/billing/calcTotal.ts", line: 4 }],
      approach: ["a"],
      chapters: [{ title: "Núcleo", body: "n", files: ["src/billing/calcTotal.ts"] }],
    })}\n\`\`\``,
  });
  if (planned?.ui) rt.spark.ui = planned.ui;
  await hub.actSpark(rt.spark.id, {
    type: "comment-add",
    id: "src/billing/calcTotal.ts:4",
    value: "guest ainda passa?",
  });
  expect((hub.sparks.get(rt.spark.id)?.spark.ui as ReviewUi).pending).toHaveLength(1);
  await hub.actSpark(rt.spark.id, { type: "comment-send" });
  const after = hub.sparks.get(rt.spark.id);
  expect((after?.spark.ui as ReviewUi).pending).toEqual([]);
  expect(after?.memory.log.some((m) => m.kind === "user" && m.text.includes("guest ainda passa?"))).toBe(true);
  await hub.actSpark(rt.spark.id, { type: "finding", id: "guest-gate", value: "resolved" });
  expect((hub.sparks.get(rt.spark.id)?.spark.ui as ReviewUi).findings[0]?.status).toBe("resolved");
  const pendingHtml = review.render!({
    ...hub.sparks.get(rt.spark.id)!.spark,
    ui: addComment(hub.sparks.get(rt.spark.id)!.spark.ui as ReviewUi, "src/billing/calcTotal.ts", 4, "x"),
  });
  expect(pendingHtml).toContain("data-act=\"comment-send\"");
  const html = review.render!(hub.sparks.get(rt.spark.id)!.spark);
  expect(html).toContain("data-finding=\"guest-gate\"");
  expect(html).toContain("data-act=\"rereview\"");
  hub.close();
});

test("open or act archives a worktree when gh says the PR merged", async () => {
  const { hub, repo } = await makeHub();
  cpSync(join(import.meta.dir, "../fixtures/gh/pr-merged.diff"), join(repo, "fixtures-pr-merged.diff"));
  const rt = await hub.sparks.open("review", { pr: "merged", wt: "1" });
  expect(rt.spark.worktree).toBe("arquivo");
  expect((rt.spark.ui as ReviewUi).prState).toBe("MERGED");
  hub.close();
});
