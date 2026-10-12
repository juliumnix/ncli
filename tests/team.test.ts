import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseTeamPrs, repoParts, teamTitle } from "../src/team/model";
import { ViewRegistry } from "../src/views/registry";
import team from "../views/team/view";
import { makeHub } from "./helpers";

test("teamTitle and parseTeamPrs are the board", () => {
  const prs = parseTeamPrs(
    JSON.stringify([{ number: 12, title: "discount", author: "ana", url: "https://github.com/acme/app/pull/12" }]),
  );
  expect(prs).toEqual([
    { number: 12, title: "discount", author: "ana", url: "https://github.com/acme/app/pull/12", draft: false },
  ]);
  expect(teamTitle({ owner: "acme", repo: "app", privateRepo: true, prs })).toBe("1 PR em acme/app");
  expect(repoParts("/tmp/ncli", "acme", "app")).toEqual({ owner: "acme", repo: "app" });
});

test("view://team holds the private repo PR list", async () => {
  const { hub } = await makeHub();
  const prs = JSON.stringify([
    { number: 12, title: "discount", author: "ana", url: "https://github.com/acme/app/pull/12" },
    { number: 13, title: "tax", author: "bo", url: "https://github.com/acme/app/pull/13", draft: true },
  ]);
  const rt = await hub.sparks.open("team", { owner: "acme", repo: "app", prs });
  expect(rt.spark.hold).toBe(true);
  expect(rt.spark.title).toBe("2 PRs em acme/app");
  const html = team.render!(rt.spark);
  expect(html).toContain("discount");
  expect(html).toContain("#13");
  expect(html).toContain("privado");
  expect(html).toContain("https://github.com/acme/app/pull/12");
  hub.close();
});

test("registry ships team alongside live, review, and refino", async () => {
  const reg = new ViewRegistry(join(import.meta.dir, "../views"));
  await reg.loadAll();
  expect(reg.list().map((v) => v.id).sort()).toEqual(["live", "refino", "review", "team"]);
});
