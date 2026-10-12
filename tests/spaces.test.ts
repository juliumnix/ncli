import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSessionFile } from "../src/import";
import { assemble } from "../src/memory/assemble";
import { mockCompressor } from "../src/memory/store";
import { isSpaceId, spaceFor, SpaceRegistry } from "../src/memory/spaces";
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
  expect(spaceFor(repo)).toBe(spaceFor(repo));
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
  expect(spaces.of("../../etc")).toBe(b);
  expect(isSpaceId("../../etc")).toBe(false);
});

test("import without cwd lands in inbox and never enters a project or global view", async () => {
  const repo = await initTempRepo("imp-cwd");
  const { hub } = await makeHub({ repo, importClaude: writeClaudeImport(repo) });
  try {
    await hub.applyImport("claude");
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

test("a Claude project slug without cwd does not invent a path or a project space", async () => {
  const repo = await initTempRepo("slug-cwd");
  const root = tmpDir("import-slug");
  const slug = join(root, "projects", "-tmp-exp2-shop", "sess.jsonl");
  mkdirSync(join(root, "projects", "-tmp-exp2-shop"), { recursive: true });
  writeFileSync(slug, `${JSON.stringify({
    type: "user",
    timestamp: "2026-10-12T00:00:00.000Z",
    message: { content: "SLUG_ORPHAN no cwd" },
  })}\n`);
  const lines = parseSessionFile("claude", slug);
  expect(lines[0]?.cwd).toBeUndefined();
  const { hub, dataDir } = await makeHub({ repo, importClaude: join(root, "projects") });
  try {
    await hub.applyImport("claude");
    expect(hub.spaces.inbox().log.some((m) => m.text.includes("SLUG_ORPHAN"))).toBe(true);
    expect(hub.memory.log.some((m) => m.text.includes("SLUG_ORPHAN"))).toBe(false);
    const spaceDirs = existsSync(join(dataDir, "spaces")) ? readdirSync(join(dataDir, "spaces")) : [];
    expect(spaceDirs.some((d) => d.startsWith("proj_"))).toBe(false);
  } finally {
    hub.close();
  }
});

test("hub zoom and recall reject a space that is not this session", async () => {
  const other = tmpDir("hub-other");
  const { hub, dataDir } = await makeHub();
  try {
    hub.memory.append({ kind: "user", text: "CURRENT_SPACE_FACT" });
    hub.spaces.of(spaceFor(other)).append({ kind: "user", text: "OTHER_SPACE_FACT" });
    const recall = await hub.callMcp("recall", { pattern: "SPACE_FACT" }, "main");
    expect(recall).toContain("CURRENT_SPACE_FACT");
    expect(recall).not.toContain("OTHER_SPACE_FACT");
    const otherId = spaceFor(other);
    const otherRecall = await hub.callMcp("recall", { pattern: "SPACE_FACT", space: otherId }, "main");
    expect(otherRecall).toBe(`space ${otherId} is not this session.`);
    const pathRecall = await hub.callMcp("recall", { pattern: "SPACE_FACT", space: "../../etc" }, "main");
    expect(pathRecall).toBe("space ../../etc is not this session.");
    const zoom = await hub.callMcp("zoom", { id: 0, n: 1 }, "main");
    expect(zoom).toContain("CURRENT_SPACE_FACT");
    expect(zoom).not.toContain("OTHER_SPACE_FACT");
    expect(hub.snapshot().context.space).toBe(spaceFor(hub.cfg.repo));
    const spaceDirs = existsSync(join(dataDir, "spaces")) ? readdirSync(join(dataDir, "spaces")) : [];
    expect(spaceDirs.some((d) => d.includes("etc"))).toBe(false);
  } finally {
    hub.close();
  }
});

test("a spark cannot read the parent project through space", async () => {
  const { hub } = await makeHub();
  try {
    hub.memory.append({ kind: "user", text: "PROJECT_ONLY_FACT" });
    const rt = await hub.sparks.open("live", {});
    rt.memory.append({ kind: "user", text: "SPARK_ONLY_FACT" });
    const parent = spaceFor(hub.cfg.repo);
    const fromSpark = await hub.callMcp("recall", { pattern: "FACT", space: parent }, rt.spark.id);
    expect(fromSpark).toBe(`space ${parent} is not this session.`);
    const own = await hub.callMcp("recall", { pattern: "FACT" }, rt.spark.id);
    expect(own).toContain("SPARK_ONLY_FACT");
    expect(own).not.toContain("PROJECT_ONLY_FACT");
    const sparkSpace = `spark:${rt.spark.id}`;
    const fromMain = await hub.callMcp("recall", { pattern: "FACT", space: sparkSpace }, "main");
    expect(fromMain).toBe(`space ${sparkSpace} is not this session.`);
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

test("spaceFor re-probes after a directory becomes a git repo", async () => {
  const root = tmpDir("becomes-repo");
  const nested = join(root, "src");
  mkdirSync(nested, { recursive: true });
  const before = spaceFor(nested);
  expect(before).toStartWith("proj:");
  const init = await realGit(["init"], root);
  expect(init.code).toBe(0);
  const after = spaceFor(nested);
  expect(after).toBe(spaceFor(root));
  expect(after).not.toBe(before);
});

test("parseSessionFile reads cwd only from the record", () => {
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
