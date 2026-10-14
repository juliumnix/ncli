import { expect, test } from "bun:test";
import { basename, join } from "node:path";
import { bootNcli } from "../src/boot";
import { displayImportRoot, isAbsolutePath, publicSpark } from "../src/import/roots";
import { makeHub, tmpDir } from "./helpers";

function absoluteLeaks(value: unknown, path = ""): string[] {
  if (typeof value === "string") {
    if (isAbsolutePath(value)) return [path || "(root)"];
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => absoluteLeaks(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      absoluteLeaks(v, path ? `${path}.${k}` : k),
    );
  }
  return [];
}

test("displayImportRoot abbreviates home and drops other absolute paths", () => {
  const home = "/Users/julio";
  expect(displayImportRoot(home, home)).toBe("~");
  expect(displayImportRoot(join(home, ".claude", "projects"), home)).toBe("~/.claude/projects");
  expect(displayImportRoot("/tmp/other", home)).toBe("other");
  expect(displayImportRoot("C:\\Users\\x\\proj", home)).toBe("proj");
  expect(publicSpark({ repo: "/opt/ncli/shop" }).repo).toBe("shop");
});

test("no API payload exposes an absolute path", async () => {
  const home = tmpDir("api-home");
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const { hub, repo } = await makeHub({
    importClaude: join(home, ".claude", "projects"),
    importCodex: join(home, ".codex", "sessions"),
    importCursor: join(home, ".cursor", "projects"),
  });
  hub.cfg.port = 19100 + Math.floor(Math.random() * 400);
  hub.previewImport("claude");
  await hub.sparks.open("live", {});
  hub.sparks.list()[0]!.repo = repo;
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  try {
    expect(isAbsolutePath(repo)).toBe(true);
    const stateRes = await fetch(`${booted.report.uiUrl}/api/state`);
    const state = await stateRes.json() as {
      import?: { root?: string };
      sparks: Array<{ repo?: string }>;
      forks: Array<{ repo?: string }>;
      waiting: Array<{ repo?: string }>;
    };
    expect(state.import?.root).toBe("~/.claude/projects");
    expect(state.sparks.some((s) => s.repo === basename(repo))).toBe(true);
    expect(state.forks.some((s) => s.repo === basename(repo))).toBe(true);
    expect(state.waiting.some((s) => s.repo === basename(repo))).toBe(true);
    expect(absoluteLeaks(state)).toEqual([]);

    const importRes = await fetch(`${booted.report.uiUrl}/api/import?source=claude`);
    const preview = await importRes.json();
    expect(preview.preview?.root.startsWith("~")).toBe(true);
    expect(absoluteLeaks(preview)).toEqual([]);

    const memRes = await fetch(`${booted.report.uiUrl}/api/memory`);
    expect(absoluteLeaks(await memRes.json())).toEqual([]);

    const viewsRes = await fetch(`${booted.report.uiUrl}/api/views`);
    expect(absoluteLeaks(await viewsRes.json())).toEqual([]);

    const sparkRes = await fetch(`${booted.report.uiUrl}/api/sparks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: "notes" }),
    });
    expect(sparkRes.status).toBe(500);
    const errBody = await sparkRes.text();
    const err = JSON.parse(errBody) as { error?: string };
    expect(err).toEqual({ error: "internal error" });
    expect(errBody).not.toContain(process.cwd());
    expect(errBody).not.toContain(home);
    expect(errBody).not.toContain(repo);
    expect(errBody).not.toMatch(/\bstack\b|^\s*at\s+/m);
    expect(absoluteLeaks(err)).toEqual([]);
  } finally {
    booted.stop();
    hub.close();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});
