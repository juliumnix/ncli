#!/usr/bin/env bun
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ncliExtractPrefix } from "../src/bunx-cache";
import { ncliSpecAt, parseRevision, readGitHead, shortSha } from "../src/revision";

export const LINES = 100;
export const FILES = 66;
const BANNER = /NCLI rodando em http:\/\/localhost:(\d+) · ([0-9a-f]{7})\b/;

function plantClaude(root: string): number {
  const proj = join(root, "workspace");
  mkdirSync(proj, { recursive: true });
  for (let f = 0; f < FILES; f++) {
    const rows = Array.from({ length: LINES }, (_, i) => JSON.stringify({
      type: i % 2 === 0 ? "user" : "assistant",
      timestamp: `2026-10-13T00:00:${String(i).padStart(2, "0")}.000Z`,
      cwd: "/workspace",
      message: { content: `line-${f}-${i}` },
    }));
    writeFileSync(join(proj, `sess-${f}.jsonl`), `${rows.join("\n")}\n`);
  }
  return FILES * LINES;
}

function plantExtract(repo: string, uid: number, work: string): string {
  const dest = join(work, `${ncliExtractPrefix(uid)}18408305413554282373`);
  mkdirSync(dest, { recursive: true });
  cpSync(join(repo, "src"), join(dest, "src"), { recursive: true });
  for (const name of ["package.json", "views", "public", "fixtures", "ncli", "scripts", "node_modules"]) {
    symlinkSync(join(repo, name), join(dest, name));
  }
  return dest;
}

async function waitBanner(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<{ port: number; short: string; text: string }> {
  const dec = new TextDecoder();
  let text = "";
  const start = Date.now();
  void (async () => {
    for await (const chunk of proc.stdout) text += dec.decode(chunk);
  })();
  void (async () => {
    for await (const chunk of proc.stderr) text += dec.decode(chunk);
  })();
  while (Date.now() - start < timeoutMs) {
    const m = text.match(BANNER);
    if (m?.[1] && m[2]) return { port: Number(m[1]), short: m[2], text };
    if (proc.exitCode !== null) throw new Error(`ncli exited ${proc.exitCode} before ready\n${text}`);
    await Bun.sleep(50);
  }
  throw new Error(`banner missing sha\n${text}`);
}

async function waitT(url: string, want: number, timeoutMs: number, proc: ReturnType<typeof Bun.spawn>, log: string): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let t = 0;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`ncli died during import: ${proc.exitCode}\n${log}`);
    const state = await fetch(`${url}/api/state`).then((r) => r.json()) as {
      debug?: { T?: number };
      import?: { seenCount?: number };
    };
    t = Math.max(state.debug?.T ?? 0, state.import?.seenCount ?? 0);
    if (t >= want) return t;
    await Bun.sleep(100);
  }
  throw new Error(`import T=${t} want ${want}`);
}

async function main(): Promise<void> {
  const repo = join(import.meta.dir, "..");
  const uid = process.getuid?.() ?? 0;
  const sha = parseRevision(process.env.NCLI_REVISION)?.sha ?? readGitHead(repo);
  if (!sha) throw new Error("ncli: need NCLI_REVISION or a git HEAD");
  const work = mkdtempSync(join(tmpdir(), "ncli-bunx-"));
  const claude = join(work, "claude");
  const expectLines = plantClaude(claude);
  const viaBunx = process.argv.includes("--bunx");
  const port = 19000 + Math.floor(Math.random() * 400);
  const env = {
    ...process.env,
    NCLI_HARNESS: "mock",
    NCLI_COMPACT: "mock",
    NCLI_GH: "mock",
    NCLI_NO_OPEN: "1",
    NCLI_REVISION: sha,
    NCLI_IMPORT_CLAUDE: claude,
    NCLI_DATA: join(work, "data"),
    NCLI_PORT: String(port),
    NCLI_REPO: join(work, "repo"),
  };
  delete env.NCLI_DEMO;
  mkdirSync(env.NCLI_REPO, { recursive: true });
  const cmd = viaBunx
    ? ["bunx", ncliSpecAt(sha)]
    : [process.execPath, join(plantExtract(repo, uid, work), "src/index.ts")];
  const bannerMs = viaBunx ? 180_000 : 20_000;
  const spawnHub = () => Bun.spawn(cmd, { cwd: env.NCLI_REPO, env, stdout: "pipe", stderr: "pipe" });
  const first = spawnHub();
  try {
    const ready = await waitBanner(first, bannerMs);
    if (ready.short !== shortSha(sha)) {
      throw new Error(`banner sha ${ready.short} != ${shortSha(sha)}\n${ready.text}`);
    }
    if (ready.text.includes("unknown")) throw new Error(`banner printed unknown\n${ready.text}`);
    const url = `http://127.0.0.1:${ready.port}`;
    const apply = await fetch(`${url}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "claude", apply: true }),
    });
    const started = await apply.json() as { ok?: boolean; started?: boolean };
    if (!started.ok || !started.started) throw new Error(`import did not start: ${JSON.stringify(started)}`);
    const half = Math.floor(expectLines / 2);
    await waitT(url, half, 60_000, first, ready.text);
    first.kill();
    await first.exited;
    const second = spawnHub();
    try {
      const again = await waitBanner(second, bannerMs);
      if (again.short !== shortSha(sha)) {
        throw new Error(`restart banner sha ${again.short} != ${shortSha(sha)}\n${again.text}`);
      }
      const t = await waitT(url, expectLines, 90_000, second, again.text);
      if (t < expectLines) throw new Error(`import T=${t} want ${expectLines}`);
      if (second.exitCode !== null) throw new Error(`ncli died after import: ${second.exitCode}`);
    } finally {
      second.kill();
      await second.exited;
    }
  } finally {
    if (first.exitCode === null) {
      first.kill();
      await first.exited;
    }
  }
}

await main();
