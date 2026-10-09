import { expect, test } from "bun:test";
import {
  assertCompactModel,
  cheapParamValue,
  resolveCompactModel,
  unknownCompactModelMessage,
} from "../src/memory/compact-model";

const HAIKU = {
  id: "claude-haiku-5-5",
  parameters: [
    { id: "effort", values: [{ value: "low" }, { value: "high" }] },
    { id: "thinking", values: [{ value: "false" }, { value: "true" }] },
    { id: "fast", values: [{ value: "false" }, { value: "true" }] },
  ],
};

test("resolveCompactModel maps a suffix id to the catalog id and cheap params", () => {
  const choice = resolveCompactModel([HAIKU], "claude-haiku-5-5-low");
  expect(choice).toEqual({
    id: "claude-haiku-5-5",
    params: [
      { id: "effort", value: "low" },
      { id: "thinking", value: "false" },
    ],
  });
  expect(resolveCompactModel([HAIKU], "claude-haiku-5-5").id).toBe("claude-haiku-5-5");
});

test("unknownCompactModelMessage names the bad id and lists catalog ids", () => {
  expect(() => resolveCompactModel([HAIKU], "claude-opus-4")).toThrow(
    unknownCompactModelMessage("claude-opus-4", ["claude-haiku-5-5"]),
  );
  expect(unknownCompactModelMessage("claude-haiku-5-5-low", ["claude-haiku-5-5"])).toContain(
    "Cannot use this model: claude-haiku-5-5-low",
  );
  expect(unknownCompactModelMessage("x", ["claude-haiku-5-5"])).toContain("claude-haiku-5-5");
});

test("cheapParamValue picks low effort and thinking off, and ignores other params", () => {
  expect(cheapParamValue({ id: "effort", values: [{ value: "high" }, { value: "low" }] })).toBe("low");
  expect(cheapParamValue({ id: "thinking", values: [{ value: "true" }, { value: "false" }] })).toBe("false");
  expect(cheapParamValue({ id: "fast", values: [{ value: "false" }, { value: "true" }] })).toBeUndefined();
});

test("assertCompactModel skips without a key and rejects a missing catalog id", async () => {
  expect(await assertCompactModel("claude-haiku-5-5", {}, async () => [HAIKU])).toBeUndefined();
  const env = { NCLI_CURSOR_API_KEY: "ncli-only-key" };
  const ok = await assertCompactModel("claude-haiku-5-5", env, async () => [HAIKU]);
  expect(ok?.id).toBe("claude-haiku-5-5");
  expect(ok?.params).toEqual([
    { id: "effort", value: "low" },
    { id: "thinking", value: "false" },
  ]);
  await expect(assertCompactModel("no-such-model", env, async () => [HAIKU])).rejects.toThrow(
    /Cannot use this model: no-such-model/,
  );
});
