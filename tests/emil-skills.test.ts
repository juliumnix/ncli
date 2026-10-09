import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assemble } from "../src/memory/assemble";
import { Memory, mockCompressor } from "../src/memory/store";
import { defaultSkillsDir, listEmilSkills, listSkills, readSkill } from "../src/skills/catalog";
import { tmpDir } from "./helpers";

const KEEP = [
  "animation-vocabulary",
  "apple-design",
  "emil-design-eng",
  "find-animation-opportunities",
  "improve-animations",
  "review-animations",
];

test("emil vendor has the six design skills, LICENSE, and SOURCE", () => {
  const root = join(defaultSkillsDir(), "emil");
  expect(existsSync(join(root, "LICENSE"))).toBe(true);
  expect(readFileSync(join(root, "LICENSE"), "utf8")).toContain("Emil Kowalski");
  expect(readFileSync(join(root, "SOURCE.md"), "utf8")).toContain("emilkowalski/skills");
  const ids = listEmilSkills().map((s) => s.id).sort();
  expect(ids).toEqual([...KEEP].sort());
  expect(listSkills().some((s) => s.id === "emil" || s.id.startsWith("emil-"))).toBe(false);
  expect(readSkill("emil-design-eng")?.dir).toContain("ncli/skills/emil/emil-design-eng");
  expect(existsSync(join(root, "review-animations", "STANDARDS.md"))).toBe(true);
});

test("every harness prompt names the emil tree", () => {
  const mem = new Memory({
    dir: tmpDir("emil-sys"),
    nodeBytes: 80,
    viewBytes: 400,
    compressor: mockCompressor(),
  });
  mem.append({ kind: "note", text: "oi" });
  const ctx = assemble(mem);
  expect(ctx.system).toContain("ncli/skills/emil/");
  expect(ctx.system).toContain("emil-design-eng");
  expect(ctx.system).toContain("sync-emil.ts");
});
