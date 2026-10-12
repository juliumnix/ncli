import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { parseViewLink, reviewPasteHint } from "../src/util";
import { makeHub, waitUntil } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const PR = "https://github.com/acme/shop/pull/482";

function shots(): string {
  const fromEnv = process.env.NCLI_SHOTS?.trim();
  if (fromEnv) return fromEnv;
  return join(tmpdir(), "ncli-shots");
}

test("parseViewLink turns a GitHub PR URL into review?pr=", () => {
  expect(parseViewLink(PR)).toEqual([{ id: "review", params: { pr: "482" } }]);
  expect(parseViewLink(`${PR}/files#diff`)).toEqual([{ id: "review", params: { pr: "482" } }]);
  expect(parseViewLink("olha https://github.com/acme/shop/pull/482 agora")).toEqual([
    { id: "review", params: { pr: "482" } },
  ]);
  expect(parseViewLink("https://github.com/acme/shop/issues/482")).toEqual([]);
  expect(parseViewLink("view://review?pr=482")).toEqual([{ id: "review", params: { pr: "482" } }]);
  expect(parseViewLink(`${PR} e view://review?pr=482`)).toEqual([{ id: "review", params: { pr: "482" } }]);
});

test("reviewPasteHint is only a lone PR URL", () => {
  expect(reviewPasteHint(`  ${PR}  `)).toEqual({ pr: "482" });
  expect(reviewPasteHint("github.com/acme/shop/pull/482/files")).toEqual({ pr: "482" });
  expect(reviewPasteHint("olha https://github.com/acme/shop/pull/482")).toBeNull();
  expect(reviewPasteHint("view://review?pr=482")).toBeNull();
  expect(reviewPasteHint("")).toBeNull();
});

test("app.js paints the paste hint and opens the matching review spark", () => {
  expect(appJs).toContain("function reviewPasteHint");
  expect(appJs).toContain("function renderPasteHint");
  expect(appJs).toContain("pendingReviewOpen");
  expect(appJs).toContain("Enter abre o spark #");
});

test("sending a PR URL opens review and skips the chat turn", async () => {
  const { hub } = await makeHub();
  try {
    await hub.send(PR);
    await waitUntil(() => hub.sparks.list().some((s) => s.view === "review"), 8000, "review spark");
    const spark = hub.sparks.list().find((s) => s.view === "review")!;
    expect(spark.status).toBe("needs_user");
    expect(spark.params.pr).toBe("482");
    expect(spark.title).toContain("482");
    expect(hub.memory.log.filter((m) => m.kind === "user").map((m) => m.text)).toEqual([PR]);
    expect(hub.memory.log.some((m) => m.kind === "talk")).toBe(false);
    expect(hub.snapshot().turning).toBe(false);
  } finally {
    hub.close();
  }
});

test("a PR URL inside a sentence still opens review and runs the turn", async () => {
  const { hub } = await makeHub();
  try {
    await hub.send(`olha ${PR}`);
    await waitUntil(() => hub.sparks.list().some((s) => s.view === "review"), 8000, "review spark");
    await waitUntil(() => hub.memory.log.some((m) => m.kind === "talk"), 8000, "talk");
    expect(hub.sparks.list()[0]?.params.pr).toBe("482");
  } finally {
    hub.close();
  }
});

test("chrome: pasting a PR URL shows the hint and Enter opens review", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  hub.cfg.port = 19300 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(9800 + Math.floor(Math.random() * 400));
  const dir = shots();
  mkdirSync(dir, { recursive: true });
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.querySelector(".welcome") && document.getElementById("input"))`),
      8000,
      "welcome",
    );
    await driver.session.evaluate(`(() => {
      const input = document.getElementById("input");
      input.focus();
      input.value = ${JSON.stringify(PR)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true }));
    })()`);
    await waitUntil(
      () => driver.session.evaluate(`(() => {
        const bar = document.getElementById("phint");
        return Boolean(bar && !bar.hidden && bar.textContent.includes("482") && bar.querySelector("[data-pr-hint='482']"));
      })()`),
      8000,
      "paste hint",
    );
    writeFileSync(join(dir, "pr-link-hint.png"), await driver.session.screenshot());
    await driver.session.evaluate(`document.getElementById("form").requestSubmit()`);
    await waitUntil(
      () => driver.session.evaluate(`(() => {
        const overlay = document.getElementById("overlay");
        const modal = document.getElementById("modal");
        return Boolean(overlay && !overlay.hidden && document.body.classList.contains("rv-open") && (modal?.textContent || "").includes("482"));
      })()`),
      12000,
      "review overlay",
    );
    const facts = await driver.session.evaluate<{
      overlayHidden: boolean;
      modal: string;
      talks: number;
    }>(`(() => {
      const overlay = document.getElementById("overlay");
      const modal = document.getElementById("modal");
      return {
        overlayHidden: Boolean(overlay?.hidden),
        modal: modal?.textContent?.replace(/\s+/g, " ").trim().slice(0, 240) || "",
        talks: document.querySelectorAll("#log .m").length,
      };
    })()`);
    expect(facts.overlayHidden).toBe(false);
    expect(facts.modal).toContain("482");
    expect(facts.talks).toBe(0);
    writeFileSync(join(dir, "pr-link-review.png"), await driver.session.screenshot());
  } finally {
    driver.close();
    booted.stop();
  }
}, 30000);
