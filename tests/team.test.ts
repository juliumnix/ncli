import { expect, test } from "bun:test";
import { join } from "node:path";
import { ViewRegistry } from "../src/views/registry";
import team from "../views/team/view";
import { makeHub } from "./helpers";

test("view://team is an example company package", async () => {
  const { hub } = await makeHub();
  try {
    const rt = await hub.sparks.open("team", {});
    expect(rt.spark.hold).toBe(true);
    expect(rt.spark.title).toBe("team");
    const html = team.render!(rt.spark);
    expect(html).toContain("ncli view add");
    expect(html).toContain("ncli-views.git");
  } finally {
    hub.close();
  }
});

test("registry ships team alongside live, review, and refino", async () => {
  const reg = new ViewRegistry(join(import.meta.dir, "../views"));
  await reg.loadAll();
  expect(reg.list().map((v) => v.id).sort()).toEqual(["live", "refino", "review", "team"]);
});
