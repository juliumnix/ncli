import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSessionFile } from "../src/import";
import { assemble } from "../src/memory/assemble";
import { mockCompressor } from "../src/memory/store";
import { spaceFor, SpaceRegistry } from "../src/memory/spaces";
import { initTempRepo, realGit } from "../src/sparks/worktree";
import { makeHub, tmpDir } from "./helpers";

test("worktrees of the same repo share a project space; another repo does not", async () => {
  const repo = await initTempRepo("space-a");
  const other = await initTempRepo("space-b");
  const wt = join(tmpdirJoin("space-wt"), "tree");
  mkdirSync(join(wt, ".."), { recursive: true });
  const add = await realGit(["worktree", "add", wt, "HEAD"], repo);
  expect(add.code).toBe(0);
  expect(spaceFor(repo)).toBe(spaceFor(wt));
  expect(spaceFor(repo)).toStartWith("proj:");
  expect(spaceFor(other)).toStartWith("proj:");
  expect(spaceFor(repo)).not.toBe(spaceFor(other));
  expect(spaceFor(repo)).not.toBe("global");
});

test("a fact in space A never appears in the default view, recall, or zoom of space B", async () => {
  const repoA = await initTempRepo("leak-a");
  const repoB = await initTempRepo("leak-b");
  const spaces = new SpaceRegistry({
    dataDir: tmpDir("spaces-reg"),
    nodeBytes: 140,
    viewBytes: 800,
    compressor: mockCompressor(),
    cwd: repoB,
  });
  const a = spaces.of(spaceFor(repoA));
  const b = spaces.current();
  a.append({ kind: "user", text: "ALPHA_ONLY_SECRET in repo A" });
  b.append({ kind: "user", text: "beta note in repo B" });
  expect(b.renderView()).not.toContain("ALPHA_ONLY_SECRET");
  expect(b.recall("ALPHA_ONLY_SECRET").join("\n")).not.toContain("ALPHA_ONLY_SECRET");
  const zoom = b.zoom(0, 1);
  expect(zoom.ok).toBe(true);
  if (zoom.ok) expect(zoom.lines.join("\n")).not.toContain("ALPHA_ONLY_SECRET");
  expect(a.renderView()).toContain("ALPHA_ONLY_SECRET");
  expect(spaces.global().renderView()).not.toContain("ALPHA_ONLY_SECRET");
});

test("import without cwd lands in inbox and never enters a project or global view", async () => {
  const repo = await initTempRepo("imp-cwd");
  const { hub } = await makeHub({ repo, importClaude: writeClaudeImport(repo) });
  try {
    hub.applyImport("claude");
    expect(hub.memory.log.some((m) => m.text.includes("PROJECT_FACT"))).toBe(true);
    expect(hub.memory.log.some((m) => m.text.includes("ORPHAN_FACT"))).toBe(false);
    expect(hub.spaces.inbox().log.some((m) => m.text.includes("ORPHAN_FACT"))).toBe(true);
    const view = assemble(hub.memory, "", "", "").view + assemble(hub.spaces.global(), "", "", "").view;
    expect(view).not.toContain("ORPHAN_FACT");
    expect(hub.spaces.assemble(hub.cfg.repo).view).not.toContain("ORPHAN_FACT");
    expect(hub.spaces.assemble(hub.cfg.repo).view).toContain("PROJECT_FACT");
  } finally {
    hub.close();
  }
});

test("hub zoom and recall stay on the current space unless space is explicit", async () => {
  const other = await initTempRepo("hub-other");
  const { hub } = await makeHub();
  try {
    hub.memory.append({ kind: "user", text: "CURRENT_SPACE_FACT" });
    hub.spaces.of(spaceFor(other)).append({ kind: "user", text: "OTHER_SPACE_FACT" });
    const recall = await hub.callMcp("recall", { pattern: "SPACE_FACT" }, "main");
    expect(recall).toContain("CURRENT_SPACE_FACT");
    expect(recall).not.toContain("OTHER_SPACE_FACT");
    const otherRecall = await hub.callMcp("recall", { pattern: "SPACE_FACT", space: spaceFor(other) }, "main");
    expect(otherRecall).toContain("OTHER_SPACE_FACT");
    const zoom = await hub.callMcp("zoom", { id: 0, n: 1 }, "main");
    expect(zoom).toContain("CURRENT_SPACE_FACT");
    expect(zoom).not.toContain("OTHER_SPACE_FACT");
    expect(hub.snapshot().context.space).toBe(spaceFor(hub.cfg.repo));
  } finally {
    hub.close();
  }
});

test("spark memory is its own space and merge lands on the parent project, not global", async () => {
  const { hub } = await makeHub();
  try {
    const rt = await hub.sparks.open("live", {});
    rt.memory.append({ kind: "user", text: "SPARK_ONLY_FACT" });
    expect(hub.memory.recall("SPARK_ONLY_FACT").join("\n")).not.toContain("SPARK_ONLY_FACT");
    expect(hub.spaces.global().recall("SPARK_ONLY_FACT").join("\n")).not.toContain("SPARK_ONLY_FACT");
    hub.memory.append({
      kind: "merge",
      text: "live spark voltou · SPARK_MERGE_LINE",
      sparkId: rt.spark.id,
    });
    expect(hub.memory.recall("SPARK_MERGE_LINE").join("\n")).toContain("SPARK_MERGE_LINE");
    expect(hub.spaces.global().recall("SPARK_MERGE_LINE").join("\n")).not.toContain("SPARK_MERGE_LINE");
  } finally {
    hub.close();
  }
});

test("parseSessionFile reads cwd from the record or the project folder", () => {
  const dir = tmpDir("cwd-jsonl");
  const file = join(dir, "sess.jsonl");
  writeFileSync(file, `${JSON.stringify({
    type: "user",
    cwd: "/srv/shop",
    timestamp: "2026-10-12T00:00:00.000Z",
    message: { content: "from cwd field" },
  })}\n`);
  const lines = parseSessionFile("claude", file);
  expect(lines[0]?.cwd).toBe("/srv/shop");
});

function tmpdirJoin(prefix: string): string {
  return tmpDir(prefix);
}

function writeClaudeImport(repo: string): string {
  const root = tmpDir("import-spaces");
  const withCwd = join(root, "projects", "shop", "sess-a.jsonl");
  const orphan = join(root, "projects", "loose", "sess-b.jsonl");
  mkdirSync(join(root, "projects", "shop"), { recursive: true });
  mkdirSync(join(root, "projects", "loose"), { recursive: true });
  writeFileSync(withCwd, `${JSON.stringify({
    type: "user",
    cwd: repo,
    timestamp: "2026-10-12T00:00:00.000Z",
    message: { content: "PROJECT_FACT from import" },
  })}\n`);
  writeFileSync(orphan, `${JSON.stringify({
    type: "user",
    timestamp: "2026-10-12T00:00:01.000Z",
    message: { content: "ORPHAN_FACT no cwd" },
  })}\n`);
  return join(root, "projects");
}
