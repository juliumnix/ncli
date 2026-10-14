import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bootNcli } from "../src/boot";
import { makeHub } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("overlay X posts /close and ignores a missing route", () => {
  const click = appJs.slice(appJs.indexOf('overlay.addEventListener("click"'));
  const close = click.slice(0, click.indexOf("const tab"));
  expect(close).toContain("hideOverlay()");
  expect(close).toContain("/api/sparks/${encodeURIComponent(id)}/close");
  expect(close).toContain('method: "POST"');
  expect(close).toContain("404");
  expect(close.indexOf("const id = state.openSpark")).toBeLessThan(close.indexOf("hideOverlay()"));
});

test("POST /api/sparks/:id/close merges the spark", async () => {
  const { hub } = await makeHub();
  hub.cfg.port = 17300 + Math.floor(Math.random() * 400);
  const rt = await hub.sparks.open("review", { pr: "482" });
  expect(rt.spark.status).toBe("needs_user");
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  try {
    const res = await fetch(`${booted.report.uiUrl}/api/sparks/${encodeURIComponent(rt.spark.id)}/close`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(hub.sparks.get(rt.spark.id)?.spark.status).toBe("merged");

    const missing = await fetch(`${booted.report.uiUrl}/api/sparks/no-such/close`, { method: "POST" });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ ok: true });
  } finally {
    booted.stop();
    hub.close();
  }
});
