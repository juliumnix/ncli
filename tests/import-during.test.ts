import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootNcli } from "../src/boot";
import { MockHarness } from "../src/harness/mock";
import { importTalkNote, withImportTalkNote } from "../src/import/progress";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, shotsDir, tmpDir, waitUntil } from "./helpers";

function writeFatWithEarlyFact(root: string, files = 24, lines = 40): void {
  const proj = join(root, "workspace");
  mkdirSync(proj, { recursive: true });
  for (let f = 0; f < files; f++) {
    const rows: string[] = [];
    for (let i = 0; i < lines; i++) {
      const text = f === 0 && i === 0
        ? "FACT_MEMBER_DISCOUNT_BEFORE_TAX o desconto entra antes do imposto e só pra member"
        : `FACT_LATER_${f}_${i} ${"W".repeat(40)}`;
      rows.push(JSON.stringify({
        type: i % 2 === 0 ? "user" : "assistant",
        timestamp: `2026-09-01T00:${String(f % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        cwd: "/workspace",
        message: { content: text },
      }));
    }
    writeFileSync(join(proj, `sess-${String(f).padStart(3, "0")}.jsonl`), `${rows.join("\n")}\n`);
  }
}

function viewAwareHarness(): MockHarness {
  return new MockHarness((prompt) => {
    const view = prompt.slice(0, prompt.lastIndexOf("\n\n") + 1);
    const q = prompt.slice(prompt.lastIndexOf("\n\n") + 2);
    if (/desconto|discount|member/i.test(q)) {
      if (view.includes("FACT_MEMBER_DISCOUNT_BEFORE_TAX")) {
        return { text: "O desconto entra antes do imposto e só pra member. FACT_MEMBER_DISCOUNT_BEFORE_TAX" };
      }
      return { text: "não sei" };
    }
    return { text: `Ok. ${q.slice(0, 80)}` };
  });
}

test("importTalkNote names the live percent", () => {
  expect(importTalkNote()).toContain("trazendo o histórico");
  expect(importTalkNote({ source: "claude", done: 21, total: 50 })).toBe(
    "Ainda estou trazendo o histórico (42%). A resposta pode mudar quando terminar.",
  );
  expect(withImportTalkNote("O desconto é antes do imposto.", { source: "claude", done: 1, total: 4 })).toContain("(25%)");
});

test("a memory question during import answers from what is already in and names the percent", async () => {
  const root = tmpDir("during-mem");
  writeFatWithEarlyFact(root, 16, 30);
  const harness = viewAwareHarness();
  const { hub } = await makeHub({ importClaude: root, harness });
  try {
    void hub.applyImport("claude", undefined, { surface: true });
    await waitUntil(() => hub.memory.log.some((m) => m.text.includes("FACT_MEMBER")), 8000, "early fact");
    await hub.send("qual o desconto do member?");
    const talk = [...hub.memory.log].reverse().find((m) => m.kind === "talk");
    expect(talk?.text).toContain("FACT_MEMBER_DISCOUNT_BEFORE_TAX");
    expect(talk?.text).toMatch(/trazendo o histórico \(\d+%\)/);
    expect(talk?.text).toContain("pode mudar");
    expect(talk?.text.includes("não sei") && !talk?.text.includes("FACT_MEMBER")).toBe(false);
  } finally {
    hub.close();
  }
});

test("eval: partial import answers the known fact and warns the rest is still migrating", async () => {
  const root = tmpDir("during-eval");
  writeFatWithEarlyFact(root, 12, 24);
  const harness = viewAwareHarness();
  const { hub } = await makeHub({ importClaude: root, harness });
  try {
    void hub.applyImport("claude", undefined, { surface: true });
    await waitUntil(() => hub.memory.log.some((m) => m.text.includes("FACT_MEMBER")), 8000, "fact");
    await hub.send("qual o desconto do member?");
    const talk = [...hub.memory.log].reverse().find((m) => m.kind === "talk")?.text ?? "";
    const report = {
      answeredFromMemory: talk.includes("FACT_MEMBER_DISCOUNT_BEFORE_TAX"),
      namedPercent: /trazendo o histórico \(\d+%\)/.test(talk),
      mayChange: talk.includes("pode mudar"),
      blockedAsUnknown: talk.trim() === "não sei",
    };
    console.log(`import-during-eval ${JSON.stringify(report)}`);
    expect(report.answeredFromMemory).toBe(true);
    expect(report.namedPercent).toBe(true);
    expect(report.mayChange).toBe(true);
    expect(report.blockedAsUnknown).toBe(false);
  } finally {
    hub.close();
  }
});

test("chrome: a memory question during import shows the fact and the migrating note", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const root = tmpDir("during-chrome");
  writeFatWithEarlyFact(root, 20, 30);
  const harness = viewAwareHarness();
  const { hub } = await makeHub({ importClaude: root, harness });
  hub.cfg.port = 11900 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  const driver = await launchChrome(12100 + Math.floor(Math.random() * 400));
  try {
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver.session.evaluate(`Boolean(document.querySelector("[data-welcome-import='claude']"))`),
      8000,
      "welcome chip",
    );
    await driver.session.evaluate(`document.querySelector("[data-welcome-import='claude']")?.click()`);
    await waitUntil(
      () => driver.session.evaluate(`/Lendo|trazendo/.test(document.body.innerText || "")`),
      8000,
      "importing",
    );
    await waitUntil(() => hub.memory.log.some((m) => m.text.includes("FACT_MEMBER")), 8000, "fact ingested");
    await driver.session.evaluate(`(() => {
      const input = document.getElementById("input");
      const form = document.getElementById("form");
      if (!input || !form) return;
      input.value = "qual o desconto do member?";
      form.requestSubmit();
    })()`);
    await waitUntil(
      () => driver.session.evaluate(`(() => {
        const text = document.body.innerText || "";
        return text.includes("FACT_MEMBER") && /trazendo o histórico/.test(text);
      })()`),
      10000,
      "memory answer with note",
    );
    const shots = shotsDir();
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, "import-during.png"), await driver.session.screenshot());
    const body = await driver.session.evaluate<string>(`(document.body.innerText || "")`);
    console.log(`import-during chrome_has_fact=${body.includes("FACT_MEMBER")} chrome_has_note=${/histórico/.test(body)}`);
    expect(body).toContain("FACT_MEMBER");
    expect(body).toMatch(/histórico/);
  } finally {
    driver.close();
    booted.stop();
  }
}, 45000);
