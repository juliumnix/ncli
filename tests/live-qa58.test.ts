import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bootNcli } from "../src/boot";
import { compartmentHtml, LIVE_PRELUDE, wrapLiveScript } from "../src/live/compartment";
import { liveBlocks, parseLive } from "../src/live/parse";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, waitUntil } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const kit = readFileSync(new URL("../public/ncli3d.js", import.meta.url), "utf8");

test("wrapLiveScript compiles under use strict and is not a param named eval", () => {
  expect(() => new Function(`return (function(eval){"use strict";})`)).toThrow(SyntaxError);
  const wrapped = wrapLiveScript("var ran=1");
  expect(wrapped).not.toMatch(/,eval\)/);
  expect(() => new Function(wrapped)).not.toThrow();
  expect(appJs).not.toMatch(/,eval\)\{"use strict"/);
  expect(kit).not.toMatch(/,eval\)\{"use strict"/);
  const html = compartmentHtml("<script>document.body.setAttribute('data-ran','1')</script>");
  expect(html).toContain("data-ran");
  expect(html).not.toMatch(/,eval\)\{"use strict"/);
});

test("```html and ~~~ui without ncli stay text; ncli and bare mermaid stay live", () => {
  expect(liveBlocks("```html\n<div>no</div>\n```")).toEqual([]);
  expect(liveBlocks("~~~ui\n<button>no</button>\n~~~")).toEqual([]);
  expect(parseLive("```html\n<div>no</div>\n```")[0]).toEqual({
    type: "text",
    text: "```html\n<div>no</div>\n```",
  });
  expect(liveBlocks("```ncli html\n<div>ok</div>\n```")).toEqual([{ kind: "html", source: "<div>ok</div>" }]);
  expect(liveBlocks("~~~ncli ui\n<button>ok</button>\n~~~")).toEqual([
    { kind: "ui", source: "<button>ok</button>" },
  ]);
  expect(liveBlocks("```mermaid\nflowchart LR\n  a[A] --> b[B]\n```")[0]).toEqual({
    kind: "mermaid",
    source: "flowchart LR\n  a[A] --> b[B]",
  });
});

test("prelude mutes document.write and the dead srcdoc is dark", () => {
  expect(LIVE_PRELUDE).toContain("muteDoc");
  expect(LIVE_PRELUDE).toContain("writeln");
  expect(LIVE_PRELUDE).toMatch(/p==="write"/);
  expect(appJs).toContain("LIVE_DEAD_SRCDOC");
  expect(appJs).toMatch(/LIVE_DEAD_SRCDOC[\s\S]*color-scheme:dark/);
  expect(appJs).toMatch(/LIVE_DEAD_SRCDOC[\s\S]*#0f0f11/);
  expect(appJs).toContain("if (!frame) return;");
  expect(appJs).not.toContain("function killAllLiveFrames");
  const fromEvent = appJs.slice(appJs.indexOf("function liveFrameFromEvent"), appJs.indexOf("function adoptLiveFrame"));
  expect(fromEvent).toContain("ev.source");
  expect(fromEvent).not.toMatch(/iframe\.name === name/);
});

test("chrome: document.write cannot leak a GET and about:blank kills one card", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const hits: string[] = [];
  const leak = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      hits.push(new URL(req.url).href);
      return new Response("leak");
    },
  });
  const url = `http://127.0.0.1:${leak.port}`;
  const { hub } = await makeHub();
  const writeFence =
    "```ncli html\n<p>safe-write</p><script>document.write('<script>location.href=" +
    JSON.stringify(url + "/?via=write") +
    "<\\/script>')</script>\n```";
  const cards = Array.from({ length: 6 }, (_, i) =>
    i === 0
      ? "```ncli html\n<p>card-0</p><script>location.href='about:blank'</script>\n```"
      : "```ncli html\n<p>card-" + i + "</p>\n```",
  );
  hub.memory.append({ kind: "talk", text: [writeFence, ...cards].join("\n\n"), seat: "claude" });
  hub.cfg.port = 0;
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    driver = await launchChrome(27000 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver!.session.evaluate(`document.querySelectorAll("iframe.live-frame").length >= 6`),
      12000,
      "six live frames",
    );
    await Bun.sleep(600);
    expect(hits.filter((h) => h.includes("via=write"))).toEqual([]);
    const before = await driver.session.evaluate<number>(
      `document.querySelectorAll("iframe.live-frame[src]").length`,
    );
    await driver.session.evaluate(`window.postMessage({type:"ncli-live",op:"nav",name:"ncliLive1"},"*")`);
    await Bun.sleep(200);
    const afterSpoof = await driver.session.evaluate<number>(
      `document.querySelectorAll("iframe.live-frame[src]").length`,
    );
    expect(afterSpoof).toBe(before);
    await driver.session.evaluate(`document.querySelector("iframe.live-frame").src = "about:blank"`);
    await waitUntil(
      () =>
        driver!.session.evaluate(
          `Boolean(document.querySelector("iframe.live-frame") && /0f0f11/.test(document.querySelector("iframe.live-frame").srcdoc || ""))`,
        ),
      4000,
      "one dark dead card",
    );
    const facts = await driver.session.evaluate<{ n: number; withSrc: number; darkDead: number }>(`(() => {
      const frames = [...document.querySelectorAll("iframe.live-frame")];
      return {
        n: frames.length,
        withSrc: frames.filter((f) => f.getAttribute("src")).length,
        darkDead: frames.filter((f) => /0f0f11|color-scheme:\\s*dark/.test(f.srcdoc || "")).length,
      };
    })()`);
    expect(facts.n).toBe(before);
    expect(facts.withSrc).toBe(before - 1);
    expect(facts.darkDead).toBe(1);
  } finally {
    driver?.close();
    booted.stop();
    leak.stop();
    hub.close();
  }
}, 30000);
