import { expect, test } from "bun:test";
import { join } from "node:path";
import { renderMarkdown } from "../src/live/markdown";
import { escapeHtml, safeHref, sanitizeViewHtml } from "../src/util";
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

test("escapeHtml is not a URL filter; view HTML and markdown drop javascript: hrefs", () => {
  expect(escapeHtml('javascript:alert(1)')).toBe("javascript:alert(1)");
  expect(safeHref("javascript:alert(1)")).toBeNull();
  expect(safeHref("JAVASCRIPT:alert(1)")).toBeNull();
  expect(safeHref("javascript&colon;alert(1)")).toBeNull();
  expect(safeHref("https://acme.example/views")).toBe("https://acme.example/views");
  const dirty = `<a href="${escapeHtml("javascript:alert(1)")}">go</a><img src='javascript:alert(1)'><form action="JaVaScRiPt:alert(1)"></form>`;
  const clean = sanitizeViewHtml(dirty);
  expect(clean).not.toMatch(/javascript:/i);
  expect(clean).toContain("<a href=\"\">go</a>");
  expect(sanitizeViewHtml('<a href="https://acme.example/ncli-views">pack</a>')).toContain('href="https://acme.example/ncli-views"');
  expect(renderMarkdown("[go](javascript:alert(1))")).not.toMatch(/href=["']?javascript:/i);
  expect(renderMarkdown("[go](javascript:alert(1))")).toContain("go");
  expect(renderMarkdown("[n](https://acme.example)")).toContain('href="https://acme.example/"');
});

test("registry ships team alongside live, review, and refino", async () => {
  const reg = new ViewRegistry(join(import.meta.dir, "../views"));
  await reg.loadAll();
  expect(reg.list().map((v) => v.id).sort()).toEqual(["live", "refino", "review", "team"]);
});
