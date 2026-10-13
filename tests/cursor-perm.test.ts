import { expect, test } from "bun:test";
import { cursorPermissionChoice } from "../src/acp/cursor";

const ncliOptions = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

test("Cursor auto-allows ncli MCP tools and leaves the rest as allow-once", () => {
  expect(
    cursorPermissionChoice({
      toolCall: { title: "mcp__ncli__recall" },
      options: ncliOptions,
    }),
  ).toBe("allow-always");
  expect(
    cursorPermissionChoice({
      toolCall: { title: "zoom" },
      options: ncliOptions,
    }),
  ).toBe("allow-always");
  expect(
    cursorPermissionChoice({
      toolCall: { title: "Shell" },
      options: ncliOptions,
    }),
  ).toBe("allow-once");
  expect(
    cursorPermissionChoice({
      toolCall: { title: "mcp__ncli__zoom" },
      options: [],
    }),
  ).toBe("allow-always");
});
