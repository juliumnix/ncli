import { expect, test } from "bun:test";
import { agentTrio, detectClis, sessionChrome, userHelp, type ChromeInput } from "../src/ui/chrome";
import { makeHub } from "./helpers";

const empty: ChromeInput = {
  messageCount: 0,
  sparkCount: 0,
  compactTokens: 0,
  compactRunning: false,
  limited: false,
  mainHarness: "claude",
};

test("empty first session shows welcome and hides the rest", () => {
  expect(sessionChrome(empty)).toEqual({
    showSwitcher: false,
    showCompact: false,
    showSparks: false,
    showViews: false,
    showWelcome: true,
  });
});

test("a spark shows sparks and views", () => {
  expect(sessionChrome({ ...empty, messageCount: 1, sparkCount: 1 })).toEqual({
    showSwitcher: true,
    showCompact: false,
    showSparks: true,
    showViews: true,
    showWelcome: false,
  });
});

test("a limit or the cursor seat shows the switcher", () => {
  expect(sessionChrome({ ...empty, messageCount: 2, limited: true })).toEqual({
    showSwitcher: true,
    showCompact: false,
    showSparks: false,
    showViews: false,
    showWelcome: false,
  });
  expect(sessionChrome({ ...empty, messageCount: 2, mainHarness: "cursor" })).toEqual({
    showSwitcher: true,
    showCompact: false,
    showSparks: false,
    showViews: false,
    showWelcome: false,
  });
  expect(sessionChrome({ ...empty, messageCount: 2, mainHarness: "mock" }).showSwitcher).toBe(false);
});

test("compact tokens turn the chip on", () => {
  expect(sessionChrome({ ...empty, compactTokens: 1 }).showCompact).toBe(true);
  expect(sessionChrome({ ...empty, compactRunning: true, compactTokens: 0 }).showCompact).toBe(true);
  expect(sessionChrome(empty).showCompact).toBe(false);
});

test("userHelp lists /help and import and skips scaffold", () => {
  const text = userHelp();
  expect(text).toContain("/help");
  expect(text).toContain("/ncli import");
  expect(text).toContain("pull request");
  expect(text).not.toContain("new view");
});

test("agentTrio marks presence and the main seat", () => {
  const rows = agentTrio({ claude: true, codex: false, cursor: true }, "cursor");
  expect(rows.map((r) => r.seat)).toEqual(["claude", "codex", "cursor"]);
  expect(rows.find((r) => r.seat === "cursor")).toEqual({ seat: "cursor", present: true, main: true });
  expect(rows.find((r) => r.seat === "codex")).toEqual({ seat: "codex", present: false, main: false });
  expect(agentTrio({ claude: true, codex: false, cursor: false }, "mock").find((r) => r.main)?.seat).toBe("claude");
});

test("snapshot reports which clis are on PATH", async () => {
  const { hub } = await makeHub();
  try {
    expect(hub.snapshot().clis).toEqual(detectClis(hub.cfg));
  } finally {
    hub.close();
  }
});
