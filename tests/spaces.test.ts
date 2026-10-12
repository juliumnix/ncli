import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mockCompressor } from "../src/memory/store";
import { tmpDir } from "./helpers";

test.failing("a fact in proj:a does not appear in proj:b view, recall, or default zoom", async () => {
  const { SpaceRegistry, spaceFor } = await import("../src/memory/spaces");
  const root = tmpDir("spaces");
  const repo = tmpDir("spaces-repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const reg = new SpaceRegistry({
    root,
    nodeBytes: 200,
    viewBytes: 4000,
    compressor: mockCompressor(),
  });
  const a = reg.for("proj:a");
  const b = reg.for("proj:b");
  a.append({ kind: "user", text: "token SECRET_FROM_A lives only here" });
  b.append({ kind: "user", text: "unrelated work in the other repo" });
  await a.settle();
  await b.settle();
  expect(b.renderView()).not.toContain("SECRET_FROM_A");
  expect(b.recall("SECRET_FROM_A")).toEqual([]);
  const zoomB = b.zoom(0, 1);
  expect(zoomB.ok).toBe(true);
  if (zoomB.ok) expect(zoomB.lines.join("\n")).not.toContain("SECRET_FROM_A");
  expect(spaceFor(join(repo, "wt-1"))).toBe(spaceFor(join(repo, "wt-2")));
});
