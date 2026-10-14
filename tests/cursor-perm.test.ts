import { expect, test } from "bun:test";
import { cursorPermissionChoice } from "../src/acp/cursor";

const ncliOptions = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

test("Cursor auto-allows only full mcp__ncli__ read-only titles", () => {
  for (const name of ["zoom", "date", "recall", "inbox", "list_views", "list_sparks", "budget"]) {
    expect(cursorPermissionChoice({ toolCall: { title: `mcp__ncli__${name}` }, options: ncliOptions })).toBe("allow-always");
  }
  expect(cursorPermissionChoice({ toolCall: { title: "mcp__ncli__zoom" }, options: [] })).toBe("allow-always");
  expect(cursorPermissionChoice({ toolCall: { title: "Shell" }, options: ncliOptions })).toBe("allow-once");
});

test("Cursor still asks for write ncli tools and loose names", () => {
  for (const title of [
    "zoom",
    "read",
    "post",
    "mcp__ncli__read",
    "mcp__ncli__supersede",
    "mcp__ncli__post",
    "mcp__ncli__ask",
    "mcp__ncli__open_spark",
    "mcp__ncli__close_spark",
    "mcp__ncli__switch_harness",
  ]) {
    expect(cursorPermissionChoice({ toolCall: { title }, options: ncliOptions })).toBe("allow-once");
  }
});
