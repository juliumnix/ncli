import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
  expect(close).not.toContain("harness.close");
  expect(close).not.toMatch(/\bkill\b/);
});

test("POST /close calls SparkManager.close, not archive or a direct kill", () => {
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const manager = readFileSync(new URL("../src/sparks/manager.ts", import.meta.url), "utf8");
  const route = server.slice(server.indexOf("/close"), server.indexOf("sparkAck"));
  expect(route).toContain("hub.sparks.close(");
  expect(route).not.toContain("archive(");
  expect(route).not.toContain("harness.close");
  expect(route).not.toMatch(/\bkill\b/);
  const close = manager.slice(manager.indexOf("async close("), manager.indexOf("async maybeArchiveMerged"));
  expect(close).toContain("rt.abort.abort()");
  expect(close).toContain("this.merge(");
  expect(close).toContain("this.maybeArchiveMerged(");
  expect(close).toContain("this.dropWorktree(");
  expect(close).not.toContain("harness.close");
  expect(close).not.toMatch(/\bkill\b/);
});

test("overlay X can open and close a spark three times without leftover worktrees", async () => {
  const { hub } = await makeHub();
  hub.cfg.port = 0;
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const paths: string[] = [];
  try {
    for (let n = 0; n < 3; n++) {
      const rt = await hub.sparks.open("refino", { card: `x-${n}` });
      const wt = rt.worktree?.path;
      expect(wt).toBeTruthy();
      expect(existsSync(wt!)).toBe(true);
      paths.push(wt!);
      const res = await fetch(`${booted.report.uiUrl}/api/sparks/${encodeURIComponent(rt.spark.id)}/close`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(hub.sparks.get(rt.spark.id)?.spark.status).toBe("merged");
      expect(rt.abort.signal.aborted).toBe(true);
      expect(existsSync(wt!)).toBe(false);
    }
    expect(new Set(paths).size).toBe(3);
  } finally {
    booted.stop();
    hub.close();
  }
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
