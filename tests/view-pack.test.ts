import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemble } from "../src/memory/assemble";
import { Memory, mockCompressor } from "../src/memory/store";
import { prepareSpawn } from "../src/mcp/inject";
import { addView, packView } from "../src/views/pack";
import { formatForkResult, validateManifest } from "../src/views/manifest";
import { ViewRegistry } from "../src/views/registry";
import { makeHub, tmpDir, waitUntil } from "./helpers";

const FIXTURE = `const plugin = {
  id: "echo",
  label: "echo",
  description: "conformance echo fork",
  tabs: ["Chat"],
  async createFork(params) {
    return {
      title: params.title ?? "echo",
      prompt: "echo spark",
      needsWorktree: false,
      flowStep: "spark",
    };
  },
  applyAction(fork, action) {
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
    "---\nname: echo-flow\ndescription: Exclusive echo flow.\n---\n\nStay in the echo fork.\n",
    "utf8",
  );
  return pack;
}

test("formatForkResult uses Portuguese singular and plural", () => {
  expect(
    formatForkResult(
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

test("main spawn does not add view package skills; fork spawn does not add ncli-bus", async () => {
  const { hub } = await makeHub();
  const main = prepareSpawn({ cfg: hub.cfg, session: "main", harness: "claude" });
  expect(main.addDir.join("\n")).toContain("ncli/skills");
  expect(main.addDir.join("\n")).not.toContain("views/review/skills");
  expect(main.agentsMd).toContain("ncli/skills");
  expect(main.agentsMd).not.toContain("review-flow");

  await hub.forks.open("review", { pr: "482" });
  const fork = prepareSpawn({
    cfg: hub.cfg,
    session: "review-1",
    harness: "claude",
    addDir: hub.views.packageOf("review")?.skillDirs,
    agentsMd: hub.injectSpawn("review-1", "claude").agentsMd,
  });
  expect(fork.addDir.join("\n")).toContain("views/review/skills");
  expect(fork.addDir.join("\n")).not.toMatch(/ncli\/skills\/(ncli-bus|add-view)/);
  expect(fork.agentsMd).toContain("review-flow");
  expect(fork.agentsMd).toContain("Exclusive skills");

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
    const rt = await hub.forks.open("echo", {});
    expect(rt.fork.flowStep).toBe("spark");
    expect(hub.injectSpawn(rt.fork.id, "mock").addDir.join("\n")).toContain("echo/skills");
    await hub.actFork(rt.fork.id, { type: "say", value: "ok" });
    await waitUntil(() => hub.memory.log.some((m) => m.kind === "merge" && m.text.includes("echo #1")));
    const line = hub.memory.log.find((m) => m.kind === "merge")!;
    expect(line.text).toContain("ok");
    expect(line.text).toContain("1 decisão");
    expect(line.text).toContain("1 artefato");
    expect(line.text).toContain("view://echo");
    expect(hub.forks.get(rt.fork.id)?.fork.result?.decisions[0]?.text).toBe("ship");
  } finally {
    hub.close();
  }
});
