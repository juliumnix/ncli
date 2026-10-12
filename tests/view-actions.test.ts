import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Spark } from "../src/types";
import { ViewRegistry } from "../src/views/registry";
import refino, { REFINE_DONE_SCORE, type RefinoUi } from "../views/refino";
import { makeHub, tmpDir } from "./helpers";

const ctx = { dataDir: tmpDir("act"), repo: tmpDir("act-repo") };

function sparkFrom(view: string, ui: unknown, extra: Partial<Spark> = {}): Spark {
  return {
    id: `${view}-1`,
    seq: 1,
    view,
    title: "card",
    status: "needs_user",
    params: {},
    createdAt: new Date().toISOString(),
    worktree: `wt/${view}-1`,
    ui,
    ...extra,
  };
}

test("registry ships review, refino, and live (refine is gone)", async () => {
  const reg = new ViewRegistry(join(import.meta.dir, "../views"));
  await reg.loadAll();
  expect(reg.get("refine")).toBeUndefined();
  expect(reg.list().map((v) => v.id).sort()).toEqual(["live", "refino", "review", "team"]);
});

test("refino mock has three role pareceres, two question chips, and score below 0.90", async () => {
  const created = await refino.createSpark({ card: "Pickup scheduling" }, ctx);
  const ui = created.ui as RefinoUi;
  expect(created.hold).toBe(true);
  expect(created.needsUser?.count).toBe(2);
  expect(created.needsUser?.label).toBe("2 perguntas pra você");
  expect(ui.score).toBe(0.78);
  expect(ui.score).toBeLessThan(REFINE_DONE_SCORE);
  expect(ui.pareceres.map((p) => p.role)).toEqual(["Produto", "Engenharia", "Analista"]);
  expect(ui.pareceres.map((p) => p.seat)).toEqual(["claude", "codex", "cursor"]);
  expect(ui.questions).toHaveLength(2);
  const html = refino.render!(sparkFrom("refino", ui));
  expect(html).toContain("PARECERES");
  expect(html).toContain("ESPERANDO VOCÊ");
  expect(html).toContain("2 perguntas pra você");
  expect(html).toContain("score 0.78");
  expect(html).toContain("block");
  expect(html).toContain("outra…");
  expect(html).toContain("wt/refino-1");
});

test("answering the last refino chip posts to the spark, score ≥ 0.90, merges, and drops the waiting badge", async () => {
  const { hub } = await makeHub();
  const rt = await hub.sparks.open("refino", { card: "Pickup scheduling" });
  expect(rt.spark.status).toBe("needs_user");
  expect(hub.sparks.waitingOnUser().some((f) => f.id === rt.spark.id)).toBe(true);

  await hub.sparks.act(rt.spark.id, { type: "answer", id: "pickup-16h", value: "block" });
  expect(rt.spark.status).toBe("needs_user");
  expect(rt.spark.needsUser?.count).toBe(1);
  expect(hub.sparks.waitingOnUser().some((f) => f.id === rt.spark.id)).toBe(true);
  expect(rt.memory.log.some((m) => m.kind === "user" && m.text.includes("block"))).toBe(true);

  await hub.sparks.act(rt.spark.id, { type: "answer", id: "remarcacao", value: "2h" });
  expect((rt.spark.ui as RefinoUi).score).toBeGreaterThanOrEqual(REFINE_DONE_SCORE);
  expect(rt.spark.status).toBe("merged");
  expect(rt.spark.needsUser).toBeUndefined();
  expect(hub.sparks.waitingOnUser().some((f) => f.id === rt.spark.id)).toBe(false);
  const line = hub.memory.log.find((m) => m.kind === "merge");
  expect(line?.text).toContain("refino #1");
  expect(line?.text).toContain("voltou");
  hub.close();
});
