import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.CAP_PORT || 47821);
const OUT = process.env.CAP_OUT || "/opt/cursor/artifacts/design-after";
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });

const shots = [
  ["01-chat", `${BASE}/`],
  ["01-empty", `${BASE}/dev.html?state=empty`],
  ["02-streaming", `${BASE}/dev.html?state=streaming`],
  ["04-resposta-longa", `${BASE}/dev.html?state=long`],
  ["05-limite", `${BASE}/dev.html?state=limit`],
  ["10-refino", `${BASE}/dev.html?state=refino`],
  ["13-composer-foco", `${BASE}/dev.html?state=focus`],
  ["14-dev-states", `${BASE}/dev.html`],
];

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function chromeShot(url, name) {
  const dest = join(OUT, `${name}.png`);
  const child = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--window-size=1440,900",
    "--virtual-time-budget=4000",
    `--user-data-dir=/tmp/ncli-chrome-${name}-${Date.now()}`,
    `--screenshot=${dest}`,
    url,
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (existsSync(dest) && statSync(dest).size > 2000) {
      child.kill("SIGKILL");
      console.log("wrote", dest, statSync(dest).size);
      return;
    }
    await wait(200);
  }
  child.kill("SIGKILL");
  throw new Error(`timeout ${name}`);
}

for (const [name, url] of shots) await chromeShot(url, name);
console.log("ok", OUT);
