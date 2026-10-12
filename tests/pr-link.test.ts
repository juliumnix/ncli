import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { FixtureGh, ghViewArgs } from "../src/gh/pr";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { ghOpenTalk, isLonePrUrl, parseViewLink, reviewPasteHint } from "../src/util";
import { makeHub, shotsDir, waitUntil } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const PR = "https://github.com/acme/shop/pull/482";
const FOREIGN = "https://github.com/outro/repo/pull/5";
const MISSING = "https://github.com/acme/shop/pull/999/files";

test("parseViewLink keeps owner/repo from a GitHub PR URL", () => {
  expect(parseViewLink(PR)).toEqual([{ id: "review", params: { pr: "482", owner: "acme", repo: "shop" } }]);
  expect(parseViewLink(`${PR}/files#diff`)).toEqual([
    { id: "review", params: { pr: "482", owner: "acme", repo: "shop" } },
  ]);
  expect(parseViewLink(`olha ${PR} agora`)).toEqual([
    { id: "review", params: { pr: "482", owner: "acme", repo: "shop" } },
  ]);
  expect(parseViewLink(FOREIGN)).toEqual([{ id: "review", params: { pr: "5", owner: "outro", repo: "repo" } }]);
  expect(parseViewLink("https://github.com/acme/shop/issues/482")).toEqual([]);
  expect(parseViewLink("view://review?pr=482")).toEqual([{ id: "review", params: { pr: "482" } }]);
  expect(parseViewLink(`${PR} e view://review?pr=482`)).toEqual([
    { id: "review", params: { pr: "482", owner: "acme", repo: "shop" } },
  ]);
});

test("gh pr view uses --repo from the URL owner/repo", () => {
  expect(ghViewArgs("5", { owner: "outro", repo: "repo" }).join(" ")).toContain("--repo outro/repo");
  expect(ghViewArgs("5").join(" ")).not.toContain("--repo");
});

test("reviewPasteHint finds a PR URL in a sentence", () => {
  expect(reviewPasteHint(`  ${PR}  `)).toEqual({ pr: "482", owner: "acme", repo: "shop" });
  expect(reviewPasteHint("github.com/acme/shop/pull/482/files")).toEqual({
    pr: "482",
    owner: "acme",
    repo: "shop",
  });
  expect(reviewPasteHint(`olha ${PR}`)).toEqual({ pr: "482", owner: "acme", repo: "shop" });
  expect(reviewPasteHint("view://review?pr=482")).toBeNull();
  expect(reviewPasteHint("")).toBeNull();
  expect(isLonePrUrl(`  ${PR}  `)).toBe(true);
  expect(isLonePrUrl(`olha ${PR}`)).toBe(false);
});

test("app.js paints the paste hint and opens the matching review spark", () => {
  expect(appJs).toContain("function reviewPasteHint");
  expect(appJs).toContain("function isLonePrUrl");
  expect(appJs).toContain("function sameReviewParams");
  expect(appJs).toContain("function renderPasteHint");
  expect(appJs).toContain("pendingReviewOpen");
  expect(appJs).toContain("Enter abre o spark #");
  expect(appJs).toContain("github\\.com\\/([\\w.-]+)\\/([\\w.-]+)\\/pull\\/(\\d+)");
});

test("sending a PR URL opens review and skips the chat turn", async () => {
  const { hub } = await makeHub();
  try {
    await hub.send(PR);
    await waitUntil(() => hub.sparks.list().some((s) => s.view === "review"), 8000, "review spark");
    const spark = hub.sparks.list().find((s) => s.view === "review")!;
    expect(spark.status).toBe("needs_user");
    expect(spark.params.pr).toBe("482");
    expect(spark.params.owner).toBe("acme");
    expect(spark.params.repo).toBe("shop");
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
    expect(hub.sparks.list()[0]?.params).toMatchObject({ pr: "482", owner: "acme", repo: "shop" });
  } finally {
    hub.close();
  }
});

test("ghOpenTalk names login vs missing vs other gh errors", () => {
  const params = { pr: "12", owner: "acme", repo: "shop" };
  expect(ghOpenTalk(params, new Error("To get started with GitHub CLI, please run: `gh auth login`"))).toBe(
    "O gh não está logado. O hub segue no ar.",
  );
  expect(ghOpenTalk(params, new Error("HTTP 401 Unauthorized"))).toContain("logado");
  expect(ghOpenTalk(params, new Error("sem fixture gh pra PR 12"))).toBe(
    "Não achei o pull request #12 acme/shop. O hub segue no ar.",
  );
  expect(ghOpenTalk(params, new Error("HTTP 403: API rate limit exceeded"))).toBe(
    "Não abri o pull request: HTTP 403: API rate limit exceeded. O hub segue no ar.",
  );
});

test("a missing PR URL keeps the hub alive", async () => {
  const { hub } = await makeHub();
  try {
    await hub.send(MISSING);
    expect(hub.snapshot().turning).toBe(false);
    expect(hub.sparks.list().some((s) => s.view === "review")).toBe(false);
    await hub.send("ainda aqui");
    await waitUntil(() => hub.memory.log.some((m) => m.kind === "user" && m.text === "ainda aqui"), 8000, "second send");
    const talks = hub.memory.log.filter((m) => m.kind === "talk").map((m) => m.text).join("\n");
    expect(talks).toContain("#999");
    expect(talks).toContain("acme/shop");
    expect(talks.toLowerCase()).toContain("hub");
  } finally {
    hub.close();
  }
});

test("a PR URL from another repo keeps owner/repo and does not crash", async () => {
  const { hub } = await makeHub();
  try {
    await hub.send(FOREIGN);
    expect(hub.snapshot().turning).toBe(false);
    expect(hub.sparks.list()).toHaveLength(0);
    const talks = hub.memory.log.filter((m) => m.kind === "talk").map((m) => m.text).join("\n");
    expect(talks).toContain("#5");
    expect(talks).toContain("outro/repo");
  } finally {
    hub.close();
  }
});

test("gh without login says the real cause", async () => {
  const { hub } = await makeHub({
    gh: {
      async view() {
        throw new Error("To get started with GitHub CLI, please run: `gh auth login`");
      },
    },
  });
  try {
    await hub.send(PR);
    const talks = hub.memory.log.filter((m) => m.kind === "talk").map((m) => m.text).join("\n");
    expect(talks).toContain("logado");
    expect(talks.toLowerCase()).not.toContain("não achei o pull request");
    expect(hub.snapshot().turning).toBe(false);
  } finally {
    hub.close();
  }
});

test("a failed open does not consume the next spark number", async () => {
  const { hub } = await makeHub();
  try {
    await hub.send(MISSING);
    expect(hub.sparks.list()).toHaveLength(0);
    await hub.send(PR);
    await waitUntil(() => hub.sparks.list().length === 1, 8000, "review after miss");
    expect(hub.sparks.list()[0]?.id).toBe("review-1");
    expect(hub.sparks.list()[0]?.seq).toBe(1);
  } finally {
    hub.close();
  }
});

test("opening a PR calls gh.view once", async () => {
  const inner = new FixtureGh(join(import.meta.dir, "../fixtures/gh"));
  let n = 0;
  const { hub } = await makeHub({
    gh: {
      async view(pr, spec) {
        n += 1;
        return inner.view(pr, spec);
      },
    },
  });
  try {
    await hub.send(PR);
    await waitUntil(() => hub.sparks.list().length === 1, 8000, "review spark");
    expect(n).toBe(1);
  } finally {
    hub.close();
  }
});

test("the same PR URL reuses the existing spark", async () => {
  const { hub } = await makeHub();
  try {
    await hub.send(PR);
    await waitUntil(() => hub.sparks.list().length === 1, 8000, "first spark");
    const id = hub.sparks.list()[0]!.id;
    await hub.send(PR);
    await hub.send(`olha ${PR}`);
    expect(hub.sparks.list().filter((s) => s.view === "review")).toHaveLength(1);
    expect(hub.sparks.list()[0]?.id).toBe(id);
  } finally {
    hub.close();
  }
});

test("chrome: pasting a PR URL shows the hint and Enter opens review", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  hub.cfg.port = 19300 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  const dir = shotsDir();
  mkdirSync(dir, { recursive: true });
  try {
    driver = await launchChrome(9800 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.querySelector(".welcome") && document.getElementById("input"))`),
      8000,
      "welcome",
    );
    await driver.session.evaluate(`(() => {
      const input = document.getElementById("input");
      input.focus();
      input.value = ${JSON.stringify("olha " + PR)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true }));
    })()`);
    await waitUntil(
      () => driver!.session.evaluate(`(() => {
        const bar = document.getElementById("phint");
        return Boolean(bar && !bar.hidden && bar.textContent.includes("482") && bar.querySelector("[data-pr-hint='482']"));
      })()`),
      8000,
      "paste hint in a sentence",
    );
    writeFileSync(`${dir}/pr-link-hint-sentence.png`, await driver.session.screenshot());
    await driver.session.evaluate(`(() => {
      const input = document.getElementById("input");
      input.value = ${JSON.stringify(PR)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await waitUntil(
      () => driver!.session.evaluate(`(() => {
        const bar = document.getElementById("phint");
        return Boolean(bar && !bar.hidden && bar.querySelector("[data-pr-hint='482']"));
      })()`),
      8000,
      "paste hint",
    );
    writeFileSync(`${dir}/pr-link-hint.png`, await driver.session.screenshot());
    await driver.session.evaluate(`document.getElementById("form").requestSubmit()`);
    await waitUntil(
      () => driver!.session.evaluate(`(() => {
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
    writeFileSync(`${dir}/pr-link-review.png`, await driver.session.screenshot());
  } finally {
    driver?.close();
    booted.stop();
  }
}, 30000);

test("chrome: a missing PR URL keeps the hub alive", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub();
  hub.cfg.port = 19400 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  const dir = shotsDir();
  mkdirSync(dir, { recursive: true });
  try {
    driver = await launchChrome(10200 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.querySelector(".welcome") && document.getElementById("input"))`),
      8000,
      "welcome",
    );
    await driver.session.evaluate(`(() => {
      const input = document.getElementById("input");
      input.value = ${JSON.stringify(MISSING)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await driver.session.evaluate(`document.getElementById("form").requestSubmit()`);
    await waitUntil(
      () => driver!.session.evaluate(`(() => {
        const log = document.getElementById("log");
        const text = log?.textContent || "";
        return text.includes("999") && text.toLowerCase().includes("hub");
      })()`),
      8000,
      "calm missing-pr talk",
    );
    const facts = await driver.session.evaluate<{
      overlayHidden: boolean;
      log: string;
      sparks: number;
    }>(`(() => {
      const overlay = document.getElementById("overlay");
      const log = document.getElementById("log");
      return {
        overlayHidden: Boolean(overlay?.hidden),
        log: log?.textContent?.replace(/\\s+/g, " ").trim().slice(0, 400) || "",
        sparks: document.querySelectorAll("#shortcuts [data-spark]").length,
      };
    })()`);
    expect(facts.overlayHidden).toBe(true);
    expect(facts.log).toContain("999");
    expect(facts.log.toLowerCase()).toContain("hub");
    writeFileSync(`${dir}/pr-link-missing.png`, await driver.session.screenshot());
    await driver.session.evaluate(`(() => {
      const input = document.getElementById("input");
      input.value = "ainda aqui";
      document.getElementById("form").requestSubmit();
    })()`);
    await waitUntil(
      () => driver!.session.evaluate(`(document.getElementById("log")?.textContent || "").includes("ainda aqui")`),
      8000,
      "hub still accepts input",
    );
  } finally {
    driver?.close();
    booted.stop();
  }
}, 30000);
