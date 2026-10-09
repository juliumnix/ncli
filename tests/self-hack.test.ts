import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assemble } from "../src/memory/assemble";
import { Memory, mockCompressor } from "../src/memory/store";
import { MockHarness } from "../src/harness/mock";
import { defaultSkillsDir, listSkills } from "../src/skills/catalog";
import { newView, removeView, runNcli } from "../src/skills/scaffold";
import { makeHub, tmpDir, waitUntil } from "./helpers";

const skillsDir = defaultSkillsDir();

function paths(viewsDir: string) {
  return { viewsDir, acpDir: tmpDir("acp"), skillsDir };
}

test("skill catalog covers every self-hack flow", () => {
  const ids = listSkills().map((s) => s.id);
  expect(ids).toEqual([
    "add-harness",
    "add-mcp",
    "add-mode",
    "add-render-kind",
    "add-shortcut",
    "add-skill",
    "add-view",
    "debug-ncli",
    "delegate-to-other-agent",
    "edit-view",
    "ncli-bus",
    "remove-view",
    "tune-memory",
  ]);
  expect(readFileSync(join(skillsDir, "add-view", "SKILL.md"), "utf8")).toContain("bun run ncli new view");
  expect(readFileSync(join(skillsDir, "remove-view", "SKILL.md"), "utf8")).toContain("bun run ncli remove view");
});

test("assembled system prompt tells the main agent the skills exist", () => {
  const mem = new Memory({
    dir: tmpDir("skill-sys"),
    nodeBytes: 80,
    viewBytes: 400,
    compressor: mockCompressor(),
  });
  mem.append({ kind: "note", text: "oi" });
  const ctx = assemble(mem);
  expect(ctx.system).toContain("ncli/skills/add-view/SKILL.md");
  expect(ctx.system).toContain("bun run ncli new view");
  expect(ctx.system).toContain("/ncli");
  expect(ctx.system).toContain("hot-reload");
});

test("scripted agent follows add-view, the view appears live, remove-view takes it away", async () => {
  const viewsDir = tmpDir("self-views");
  mkdirSync(viewsDir, { recursive: true });
  const harness = new MockHarness((prompt, session) => {
    const user = prompt.split("\n\n").at(-1) ?? prompt;
    if (session && session !== "main") {
      return { text: `fork ${session} ok` };
    }
    if (/cria uma view ping/i.test(user)) {
      return {
        tools: [{ name: "Read", input: { path: "ncli/skills/add-view/SKILL.md" } }],
        text: "Li ncli/skills/add-view/SKILL.md. Vou rodar bun run ncli new view ping.",
      };
    }
    if (/remove a view ping/i.test(user)) {
      return {
        tools: [{ name: "Read", input: { path: "ncli/skills/remove-view/SKILL.md" } }],
        text: "Li ncli/skills/remove-view/SKILL.md. bun run ncli remove view ping.",
      };
    }
    return { text: "ok" };
  });
  const { hub } = await makeHub({ viewsDir, harness });
  try {
    expect(hub.views.get("ping")).toBeUndefined();

    await hub.send("cria uma view ping no NCLI");
    expect(harness.lastSystems.at(-1)).toContain("add-view");
    expect(harness.lastSystems.at(-1)).toContain("ncli/skills/");
    const addSkill = readFileSync(join(skillsDir, "add-view", "SKILL.md"), "utf8");
    expect(addSkill).toContain("bun run ncli new view <id>");
    expect(hub.memory.log.some((m) => m.kind === "talk" && m.text.includes("ncli new view ping"))).toBe(true);

    newView("ping", paths(viewsDir));
    await waitUntil(() => Boolean(hub.views.get("ping")));
    expect(hub.views.get("ping")?.id).toBe("ping");
    const created = await hub.views.get("ping")!.createFork({}, { dataDir: viewsDir, repo: viewsDir });
    expect(created.title).toBe("ping");

    await hub.send("view://ping");
    await waitUntil(() => hub.forks.list().some((f) => f.view === "ping"));

    await hub.send("remove a view ping");
    expect(hub.memory.log.some((m) => m.kind === "talk" && m.text.includes("ncli remove view ping"))).toBe(true);
    removeView("ping", paths(viewsDir));
    await waitUntil(() => !hub.views.get("ping") && !existsSync(join(viewsDir, "ping.ts")));
    expect(hub.views.list().map((v) => v.id)).not.toContain("ping");
  } finally {
    hub.close();
  }
});

test("/ncli new view and /ncli remove view scaffold against a live hub", async () => {
  const viewsDir = tmpDir("slash-views");
  mkdirSync(viewsDir, { recursive: true });
  const { hub, harness } = await makeHub({ viewsDir });
  try {
    await hub.send("/ncli new view pong");
    expect(harness.lastPrompts).toEqual([]);
    await waitUntil(() => Boolean(hub.views.get("pong")));
    expect(hub.memory.log.some((m) => m.kind === "note" && m.text.includes("pong.ts"))).toBe(true);
    await hub.send("/ncli remove view pong");
    await waitUntil(() => !hub.views.get("pong"));
  } finally {
    hub.close();
  }
});

test("ncli CLI lists skills and refuses to delete a shipped view", () => {
  const listed = runNcli(["skills"], paths(tmpDir("cli-views")));
  expect(listed).toContain("add-view");
  expect(listed).toContain("debug-ncli");
  expect(() => removeView("review", paths(tmpDir("cli-views")))).toThrow(/shipped/);
});
