import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { displayImportRoot } from "../src/import/roots";
import { makeHub } from "./helpers";

function homeLeaks(value: unknown, home: string, path = ""): string[] {
  if (typeof value === "string") {
    if (value === home || value.startsWith(`${home}/`) || value.startsWith(`${home}\\`)) {
      return [path || "(root)"];
    }
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => homeLeaks(v, home, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      homeLeaks(v, home, path ? `${path}.${k}` : k),
    );
  }
  return [];
}

test("displayImportRoot abbreviates the user home", () => {
  const home = homedir();
  expect(displayImportRoot(home, home)).toBe("~");
  expect(displayImportRoot(join(home, ".claude", "projects"), home)).toBe("~/.claude/projects");
  expect(displayImportRoot("/tmp/other", home)).toBe("/tmp/other");
});

test("no API payload exposes an absolute home path", async () => {
  const home = homedir();
  const { hub } = await makeHub({
    importClaude: join(home, ".claude", "projects"),
    importCodex: join(home, ".codex", "sessions"),
    importCursor: join(home, ".cursor", "projects"),
  });
  hub.cfg.port = 19100 + Math.floor(Math.random() * 400);
  hub.previewImport("claude");
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  try {
    const stateRes = await fetch(`${booted.report.uiUrl}/api/state`);
    const state = await stateRes.json();
    expect(state.import?.root).toBe("~/.claude/projects");
    expect(homeLeaks(state, home)).toEqual([]);

    const importRes = await fetch(`${booted.report.uiUrl}/api/import?source=claude`);
    const preview = await importRes.json();
    expect(preview.preview?.root.startsWith("~")).toBe(true);
    expect(homeLeaks(preview, home)).toEqual([]);

    const memRes = await fetch(`${booted.report.uiUrl}/api/memory`);
    expect(homeLeaks(await memRes.json(), home)).toEqual([]);

    const viewsRes = await fetch(`${booted.report.uiUrl}/api/views`);
    expect(homeLeaks(await viewsRes.json(), home)).toEqual([]);
  } finally {
    booted.stop();
    hub.close();
  }
});
