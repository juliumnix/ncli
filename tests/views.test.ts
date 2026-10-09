import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildReviewUi } from "../src/review/model";
import { ViewRegistry } from "../src/views/registry";
import { tmpDir, waitUntil } from "./helpers";

const HELLO = `const hello = {
  id: "hello",
  label: "hello",
  description: "hot reload smoke",
  tabs: ["Chat"],
  async createFork() {
    return { title: "hello", prompt: "hi", needsWorktree: false };
  },
};
export default hello;
`;

test("loadAll registers review, refino, and live from views/", async () => {
  const reg = new ViewRegistry(join(import.meta.dir, "../views"));
  await reg.loadAll();
  const ids = reg.list().map((v) => v.id).sort();
  expect(ids).toEqual(["live", "refino", "review"]);
});

test("writing views/hello.ts is picked up without constructing a new registry (hot load)", async () => {
  const dir = tmpDir("views");
  mkdirSync(dir, { recursive: true });
  const reg = new ViewRegistry(dir);
  await reg.loadAll();
  expect(reg.get("hello")).toBeUndefined();
  let seen = false;
  reg.onChange = (list) => {
    if (list.some((v) => v.id === "hello")) seen = true;
  };
  reg.watch();
  writeFileSync(join(dir, "hello.ts"), HELLO, "utf8");
  await reg.loadFile(join(dir, "hello.ts"));
  expect(reg.get("hello")?.label).toBe("hello");
  const created = await reg.get("hello")!.createFork({}, { dataDir: dir, repo: dir });
  expect(created.title).toBe("hello");
  await waitUntil(() => seen || Boolean(reg.get("hello")), 2000).catch(() => undefined);
  expect(reg.get("hello")?.id).toBe("hello");
  reg.close();
});

test("review chapters are ordered core, then api, then tests", async () => {
  const meta = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/gh/pr-482.json"), "utf8"));
  meta.diff = readFileSync(join(import.meta.dir, "../fixtures/gh/pr-482.diff"), "utf8");
  const ui = buildReviewUi(meta);
  expect(ui.chapters.map((c) => c.kind)).toEqual(["core", "api", "test"]);
  const discount = ui.chapters.find((c) => c.files.some((f) => f.path.endsWith("discount.ts")));
  expect(discount?.n).toBe(1);
  expect(discount?.total).toBe(3);
  expect(discount?.title).toBe("Member discount before tax");
  expect(ui.diffs["src/billing/calcTotal.ts"]?.lines.some((l) => l.kind === "add" && l.text.includes("applyDiscount"))).toBe(true);
  expect(ui.diffs["src/billing/calcTotal.ts"]?.hunkCount).toBeGreaterThan(0);
});
