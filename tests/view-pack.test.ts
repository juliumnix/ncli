import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemble } from "../src/memory/assemble";
import { Memory, mockCompressor } from "../src/memory/store";
import { prepareSpawn } from "../src/mcp/inject";
import { removeView, runNcli } from "../src/skills/scaffold";
import { addView, packView, parseViewSource, readViewOrigin, updateView, userGitEnv } from "../src/views/pack";
import { assertRunnable, formatSparkResult, validateManifest } from "../src/views/manifest";
import { ViewRegistry } from "../src/views/registry";
import { makeHub, tmpDir, waitUntil } from "./helpers";

const FIXTURE = `const plugin = {
  id: "echo",
  label: "echo",
  description: "conformance echo spark",
  tabs: ["Chat"],
  async createSpark(params) {
    return {
      title: params.title ?? "echo",
      prompt: "echo spark",
      needsWorktree: false,
      flowStep: "spark",
    };
  },
  applyAction(spark, action) {
    if (action.type === "say" || action.type === "done") {
      return { merge: true, summary: action.value ?? "echoed", flowStep: "result" };
    }
    return;
  },
  result() {
    return {
      summary: "echoed",
      artifacts: [{ kind: "note", label: "out", text: "ok" }],
      decisions: [{ id: "go", text: "ship" }],
      links: ["view://echo"],
    };
  },
};
export default plugin;
`;

function writeEcho(dir: string): string {
  const pack = join(dir, "echo");
  mkdirSync(join(pack, "skills", "echo-flow"), { recursive: true });
  writeFileSync(
    join(pack, "manifest.json"),
    JSON.stringify({
      name: "echo",
      version: "1.0.0",
      description: "conformance echo",
      requires: { harnesses: ["mock"] },
      agents: [{ id: "lead", role: "lead", harness: "mock" }],
      skills: ["skills"],
      mcp: "mcp.json",
      flow: [
        { id: "spark", title: "Brief", agent: "lead", kind: "spark", next: "result" },
        { id: "result", title: "Return", agent: "lead", kind: "result" },
      ],
    }),
    "utf8",
  );
  writeFileSync(join(pack, "view.ts"), FIXTURE, "utf8");
  writeFileSync(
    join(pack, "skills", "echo-flow", "SKILL.md"),
    "---\nname: echo-flow\ndescription: Exclusive echo flow.\n---\n\nStay in the echo spark.\n",
    "utf8",
  );
  writeFileSync(
    join(pack, "mcp.json"),
    JSON.stringify({ mcpServers: { echo: { command: "true", args: [] } } }),
    "utf8",
  );
  return pack;
}

function gitCommit(dir: string): void {
  const run = (args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString() || r.stdout.toString());
  };
  run(["init"]);
  run(["config", "user.email", "pack@ncli.test"]);
  run(["config", "user.name", "ncli"]);
  run(["add", "-A"]);
  run(["commit", "-m", "pack"]);
}

test("formatSparkResult uses Portuguese singular and plural", () => {
  expect(
    formatSparkResult(
      { view: "review", seq: 5 },
      {
        summary: "ok",
        artifacts: [
          { kind: "chapter", label: "a" },
          { kind: "chapter", label: "b" },
          { kind: "chapter", label: "c" },
        ],
        decisions: [
          { id: "1", text: "x" },
          { id: "2", text: "y" },
        ],
        links: ["view://review?pr=482"],
      },
    ),
  ).toBe("review #5 voltou · ok · 2 decisões · 3 artefatos · view://review?pr=482");
});

test("manifest rejects personal paths and unknown harnesses", () => {
  expect(() =>
    validateManifest({
      name: "x",
      version: "1.0.0",
      description: "x",
      requires: { harnesses: ["claude"] },
      agents: [{ id: "a", role: "a", harness: "claude", model: "~/.cursor/m" }],
      skills: ["skills"],
      flow: [
        { id: "spark", title: "s", agent: "a", kind: "spark", next: "result" },
        { id: "result", title: "r", agent: "a", kind: "result" },
      ],
    }),
  ).toThrow(/pessoal|relativo|cursor/i);
  expect(() =>
    validateManifest({
      name: "x",
      version: "1",
      description: "x",
      requires: { harnesses: ["claude"] },
      agents: [{ id: "a", role: "a", harness: "claude" }],
      skills: ["../secrets"],
      flow: [
        { id: "spark", title: "s", agent: "a", kind: "spark", next: "result" },
        { id: "result", title: "r", agent: "a", kind: "result" },
      ],
    }),
  ).toThrow(/semver|relativo/i);
});

test("review and refino load as packages with exclusive skills", async () => {
  const reg = new ViewRegistry(join(import.meta.dir, "../views"));
  await reg.loadAll();
  expect(reg.packageOf("live")).toBeUndefined();
  const review = reg.packageOf("review");
  expect(review?.manifest.version).toBe("1.0.0");
  expect(review?.skillDirs.some((d) => d.includes("review/skills"))).toBe(true);
  expect(reg.packageOf("refino")?.manifest.agents.map((a) => a.id)).toEqual(["produto", "engenharia", "analista"]);
});

test("main spawn does not add view package skills; spark spawn does not add ncli-bus", async () => {
  const { hub } = await makeHub();
  const main = prepareSpawn({ cfg: hub.cfg, session: "main", harness: "claude" });
  expect(main.addDir.join("\n")).toContain("ncli/skills");
  expect(main.addDir.join("\n")).not.toContain("views/review/skills");
  expect(main.agentsMd).toContain("ncli/skills");
  expect(main.agentsMd).not.toContain("review-flow");

  await hub.sparks.open("review", { pr: "482" });
  const spark = prepareSpawn({
    cfg: hub.cfg,
    session: "review-1",
    harness: "claude",
    addDir: hub.views.packageOf("review")?.skillDirs,
    agentsMd: hub.injectSpawn("review-1", "claude").agentsMd,
  });
  expect(spark.addDir.join("\n")).toContain("views/review/skills");
  expect(spark.addDir.join("\n")).not.toMatch(/ncli\/skills\/(ncli-bus|add-view)/);
  expect(spark.agentsMd).toContain("review-flow");
  expect(spark.agentsMd).toContain("Exclusive skills");

  const mem = new Memory({ dir: tmpDir("asm"), nodeBytes: 80, viewBytes: 200, compressor: mockCompressor() });
  mem.append({ kind: "note", text: "oi" });
  const mainCtx = assemble(mem);
  expect(mainCtx.system).toContain("add-view");
  expect(mainCtx.system).not.toContain("review-flow");
  hub.close();
});

test("ncli view add from a clean dir runs the flow on mock and returns a structured result", async () => {
  const src = writeEcho(tmpDir("echo-src"));
  const viewsDir = tmpDir("echo-views");
  const installed = addView(src, viewsDir);
  expect(installed).toContain("/echo");
  const packed = packView("echo", viewsDir, tmpDir("echo-pack"));
  expect(readFileSync(join(packed, "PACK.json"), "utf8")).toContain("\"name\": \"echo\"");

  const { hub } = await makeHub({ viewsDir });
  try {
    await waitUntil(() => Boolean(hub.views.get("echo")));
    const rt = await hub.sparks.open("echo", {});
    expect(rt.spark.flowStep).toBe("spark");
    expect(hub.injectSpawn(rt.spark.id, "mock").addDir.join("\n")).toContain("echo/skills");
    await hub.actSpark(rt.spark.id, { type: "say", value: "ok" });
    await waitUntil(() => hub.memory.log.some((m) => m.kind === "merge" && m.text.includes("echo #1")));
    const line = hub.memory.log.find((m) => m.kind === "merge")!;
    expect(line.text).toContain("ok");
    expect(line.text).toContain("1 decisão");
    expect(line.text).toContain("1 artefato");
    expect(line.text).toContain("view://echo");
    expect(hub.sparks.get(rt.spark.id)?.spark.result?.decisions[0]?.text).toBe("ship");
    expect(hub.injectSpawn(rt.spark.id, "mock").mcpServers.some((s) => s.name === "echo")).toBe(true);
    expect(hub.injectSpawn("main", "mock").mcpServers.some((s) => s.name === "echo")).toBe(false);
  } finally {
    hub.close();
  }
});

test("manifest rejects personal model pins; missing harness fails install and open", () => {
  expect(() =>
    validateManifest({
      name: "x",
      version: "1.0.0",
      description: "x",
      requires: { harnesses: ["claude"], models: { claude: "~/.claude/model" } },
      agents: [{ id: "a", role: "a", harness: "claude" }],
      skills: ["skills"],
      flow: [
        { id: "spark", title: "s", agent: "a", kind: "spark", next: "result" },
        { id: "result", title: "r", agent: "a", kind: "result" },
      ],
    }),
  ).toThrow(/pessoal|claude/i);

  expect(() => assertRunnable(
    validateManifest({
      name: "onlycx",
      version: "1.0.0",
      description: "x",
      requires: { harnesses: ["codex"] },
      agents: [{ id: "a", role: "a", harness: "codex" }],
      skills: ["skills"],
      flow: [
        { id: "spark", title: "s", agent: "a", kind: "spark", next: "result" },
        { id: "result", title: "r", agent: "a", kind: "result" },
      ],
    }),
    ["mock"],
  )).toThrow(/onlycx@1\.0\.0.*codex/);

  const src = writeEcho(tmpDir("echo-req"));
  const raw = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")) as {
    requires: { harnesses: string[] };
    agents: Array<{ harness: string }>;
  };
  raw.requires.harnesses = ["codex"];
  raw.agents[0]!.harness = "codex";
  writeFileSync(join(src, "manifest.json"), JSON.stringify(raw), "utf8");
  expect(() => addView(src, tmpDir("echo-req-views"), ["mock"])).toThrow(/codex/);
});

test("opening a pack fails when no required harness is on this host", async () => {
  const src = writeEcho(tmpDir("echo-open-src"));
  const raw = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")) as {
    requires: { harnesses: string[] };
    agents: Array<{ harness: string }>;
  };
  raw.requires.harnesses = ["cursor"];
  raw.agents[0]!.harness = "cursor";
  writeFileSync(join(src, "manifest.json"), JSON.stringify(raw), "utf8");
  const viewsDir = tmpDir("echo-open-views");
  addView(src, viewsDir);
  const { hub } = await makeHub({ viewsDir });
  try {
    await waitUntil(() => Boolean(hub.views.get("echo")));
    await expect(hub.sparks.open("echo", {})).rejects.toThrow(/echo@1\.0\.0.*cursor/);
  } finally {
    hub.close();
  }
});

test("ncli view add from a local git url installs the pack and runs the mock flow", async () => {
  const src = writeEcho(tmpDir("echo-git-src"));
  gitCommit(src);
  const viewsDir = tmpDir("echo-git-views");
  const installed = addView(`file://${src}`, viewsDir, ["mock"]);
  expect(JSON.parse(readFileSync(join(installed, "manifest.json"), "utf8")).name).toBe("echo");
  expect(readFileSync(join(installed, "mcp.json"), "utf8")).toContain("\"echo\"");

  const { hub } = await makeHub({ viewsDir });
  try {
    await waitUntil(() => Boolean(hub.views.get("echo")));
    const rt = await hub.sparks.open("echo", {});
    await hub.actSpark(rt.spark.id, { type: "say", value: "from-git" });
    await waitUntil(() => hub.memory.log.some((m) => m.kind === "merge" && m.text.includes("from-git")));
    expect(hub.sparks.get(rt.spark.id)?.spark.result?.links).toEqual(["view://echo"]);
  } finally {
    hub.close();
  }
});

test("userGitEnv keeps GH_TOKEN and disables the TTY prompt", () => {
  const env = userGitEnv({ GH_TOKEN: "ghs_test", PATH: "/bin" });
  expect(env.GH_TOKEN).toBe("ghs_test");
  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(parseViewSource("git@github.com:acme/ncli-views.git#v1")).toEqual({
    kind: "git",
    url: "git@github.com:acme/ncli-views.git",
    ref: "v1",
  });
});

function git(dir: string, args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString() || r.stdout.toString());
}

function writeGuard(dir: string): string {
  const file = join(dir, "upload-pack");
  writeFileSync(
    file,
    `#!/bin/sh
if [ -z "$NCLI_VIEW_TOKEN" ]; then
  echo "fatal: Authentication failed" >&2
  exit 1
fi
exec git upload-pack "$@"
`,
  );
  chmodSync(file, 0o755);
  return file;
}

test("ncli view add from a private local git repo pins, updates, and removes", () => {
  const src = writeEcho(tmpDir("acme-views"));
  gitCommit(src);
  git(src, ["tag", "v1.0.0"]);
  const raw = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")) as { version: string };
  raw.version = "1.1.0";
  writeFileSync(join(src, "manifest.json"), JSON.stringify(raw), "utf8");
  writeFileSync(join(src, "NOTE.md"), "v2\n");
  git(src, ["add", "-A"]);
  git(src, ["commit", "-m", "v2"]);
  git(src, ["tag", "v1.1.0"]);

  const guard = writeGuard(tmpDir("acme-guard"));
  const url = `file://${src}`;
  const viewsDir = tmpDir("acme-install");
  const denied = { ...process.env };
  delete denied.NCLI_VIEW_TOKEN;
  expect(() => addView(`${url}#v1.0.0`, viewsDir, ["mock"], { env: denied, uploadPack: guard })).toThrow(
    /Authentication failed|privad|clonar/,
  );

  const installed = addView(`${url}#v1.0.0`, viewsDir, ["mock"], {
    env: { ...process.env, NCLI_VIEW_TOKEN: "secret" },
    uploadPack: guard,
  });
  const origin = readViewOrigin(installed);
  expect(origin?.url).toBe(url);
  expect(origin?.ref).toBe("v1.0.0");
  expect(origin?.pin).toMatch(/^[0-9a-f]{40}$/);
  expect(JSON.parse(readFileSync(join(installed, "manifest.json"), "utf8")).version).toBe("1.0.0");

  const updated = updateView("echo", viewsDir, "v1.1.0", ["mock"], {
    env: { ...process.env, NCLI_VIEW_TOKEN: "secret" },
    uploadPack: guard,
  });
  const next = readViewOrigin(updated);
  expect(next?.ref).toBe("v1.1.0");
  expect(next?.pin).toMatch(/^[0-9a-f]{40}$/);
  expect(next?.pin).not.toBe(origin?.pin);
  expect(JSON.parse(readFileSync(join(updated, "manifest.json"), "utf8")).version).toBe("1.1.0");

  removeView("echo", { viewsDir, acpDir: tmpDir("acme-acp") });
  expect(existsSync(updated)).toBe(false);
});

test("updateView rejects ../ as an id and addView from ../ stays inside viewsDir", () => {
  const root = tmpDir("escape-root");
  const viewsDir = join(root, "views");
  const victim = join(root, "cli-victim");
  mkdirSync(viewsDir, { recursive: true });
  mkdirSync(victim);
  writeFileSync(join(victim, "KEEP"), "alive");
  const src = writeEcho(tmpDir("escape-src"));
  gitCommit(src);
  writeFileSync(join(victim, ".ncli-source.json"), JSON.stringify({ kind: "git", url: `file://${src}` }));

  expect(() => updateView("../cli-victim", viewsDir, undefined, ["mock"])).toThrow(/id inválido/);
  expect(existsSync(join(victim, "KEEP"))).toBe(true);

  expect(() => runNcli(["view", "update", "../cli-victim"], { viewsDir, acpDir: tmpDir("escape-acp") })).toThrow(
    /id inválido/,
  );
  expect(existsSync(join(victim, "KEEP"))).toBe(true);

  const pack = writeEcho(join(root, "packsrc"));
  const installed = addView(join(viewsDir, "..", "packsrc", "echo"), viewsDir, ["mock"]);
  expect(installed.startsWith(viewsDir + "/")).toBe(true);
  expect(existsSync(join(pack, "manifest.json"))).toBe(true);
  expect(existsSync(join(victim, "KEEP"))).toBe(true);
});
