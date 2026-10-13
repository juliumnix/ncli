import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, shotsDir, tmpDir, waitUntil } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const CLAUDE = join(import.meta.dir, "../fixtures/import/claude/projects");
const SHOTS = shotsDir();

test("empty hub offers the richest CLI history and welcome has one-click import", async () => {
  expect(appJs).toContain("data-welcome-import");
  expect(appJs).toContain("jobInd");
  expect(appJs).not.toContain("compactando");
  const { hub } = await makeHub({ importClaude: CLAUDE });
  try {
    expect(hub.lastImport?.source).toBe("claude");
    expect(hub.lastImport?.sessions).toBeGreaterThan(0);
    expect(hub.importOffers).toEqual([{ source: "claude", sessions: hub.lastImport!.sessions }]);
  } finally {
    hub.close();
  }
});

test("empty-session apply surfaces Claude history in this chat when cwd is another repo", async () => {
  const { hub } = await makeHub({ importClaude: CLAUDE });
  const imports: Array<{ messages?: { text: string }[] }> = [];
  hub.subscribe((ev) => {
    if (ev.type === "import") imports.push(ev);
  });
  try {
    const result = await hub.applyImport("claude", undefined, { surface: true });
    expect(result.applied).toBeGreaterThan(0);
    expect(hub.memory.log.some((m) => m.text.includes("FACT_MEMBER_DISCOUNT_BEFORE_TAX"))).toBe(true);
    expect(hub.lastImport?.newCount).toBe(0);
    const last = imports.at(-1);
    expect(last?.messages?.length).toBeGreaterThan(0);
    expect(last?.messages?.some((m) => m.text.includes("FACT_MEMBER_DISCOUNT_BEFORE_TAX"))).toBe(true);
  } finally {
    hub.close();
  }
});

test("chrome: empty session shows welcome and the claude import bar", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hub } = await makeHub({ importClaude: CLAUDE });
  hub.cfg.port = 18400 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(11200 + Math.floor(Math.random() * 400));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`(() => {
        const bar = document.getElementById("ibar");
        return Boolean(document.querySelector(".welcome") && bar && !bar.hidden && bar.querySelector("[data-import-apply]"));
      })()`),
      8000,
      "welcome and import bar",
    );
    const facts = await driver.session.evaluate<{
      welcome: string;
      barHidden: boolean;
      barText: string;
      apply: string | null;
    }>(`(() => {
      const bar = document.getElementById("ibar");
      const apply = bar?.querySelector("[data-import-apply]");
      return {
        welcome: document.querySelector(".welcome")?.textContent?.trim() || "",
        barHidden: Boolean(bar?.hidden),
        barText: bar?.textContent?.trim() || "",
        apply: apply ? apply.getAttribute("data-import-apply") : null,
      };
    })()`);
    expect(facts.welcome).toContain("O mesmo Claude do CLI");
    expect(facts.barHidden).toBe(false);
    expect(facts.barText).toContain("claude");
    expect(facts.barText).toMatch(/sessão|novas/);
    expect(facts.apply).toBe("claude");
    const go = await driver.session.evaluate<string[]>(
      `[...document.querySelectorAll("[data-welcome-import]")].map((el) => el.getAttribute("data-welcome-import"))`,
    );
    expect(go).toEqual(["claude"]);
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(`${SHOTS}/import-onboard.png`, await driver.session.screenshot());
  } finally {
    driver.close();
    booted.stop();
  }
}, 30000);

test("chrome: welcome chip shows live import percent", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const root = tmpDir("fat-welcome");
  const proj = join(root, "workspace");
  mkdirSync(proj, { recursive: true });
  for (let f = 0; f < 24; f++) {
    const rows = Array.from({ length: 16 }, (_, i) => JSON.stringify({
      type: "user",
      timestamp: `2026-10-12T0${f}:00:${String(i).padStart(2, "0")}.000Z`,
      cwd: "/workspace",
      message: { content: `FACT_LINE_${f}_${i}` },
    }));
    writeFileSync(join(proj, `sess-${f}.jsonl`), `${rows.join("\n")}\n`);
  }
  const { hub } = await makeHub({ importClaude: root });
  hub.cfg.port = 18500 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(11400 + Math.floor(Math.random() * 400));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.querySelector("[data-welcome-import='claude']"))`),
      8000,
      "welcome chip",
    );
    mkdirSync(SHOTS, { recursive: true });
    await driver.session.evaluate(`document.querySelector("[data-welcome-import='claude']")?.click()`);
    const seen: string[] = [];
    await waitUntil(async () => {
      const label = await driver.session.evaluate<string>(
        `document.getElementById("jobInd")?.innerText || document.querySelector("[data-welcome-import='claude']")?.textContent || ""`,
      );
      if (/Lendo/.test(label) && !seen.includes(label)) {
        seen.push(label);
        writeFileSync(`${SHOTS}/import-progress-${seen.length}.png`, await driver.session.screenshot());
      }
      return seen.some((t) => /Lendo seu histórico/.test(t));
    }, 8000, "job rail");
    const label = seen.at(-1) ?? "";
    expect(label).toMatch(/Lendo seu histórico do Claude/);
    expect(label).not.toMatch(/compactando/);
    writeFileSync(`${SHOTS}/import-progress.png`, await driver.session.screenshot());
    console.log(`import-progress chrome_labels=${JSON.stringify(seen)}`);
  } finally {
    driver.close();
    booted.stop();
  }
}, 30000);
