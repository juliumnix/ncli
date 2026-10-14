// Child that boots ncli exactly like src/index.ts, plus an optional fake compactor
// pool that spawns `codex exec` processes (stand-in for the PR #65 engine).
import { appendFileSync } from "node:fs";
import { bootNcli } from "../../src/boot";
import { registerBootShutdown } from "../../src/boot-shutdown";
import { installChildShutdown, setCompactorKiller } from "../../src/shutdown";

installChildShutdown();
const booted = await bootNcli({ openBrowser: false });
registerBootShutdown(booted);

const fake = process.env.NCLI_TEST_FAKE_CODEX;
const pidsFile = process.env.NCLI_TEST_CODEX_PIDS;
if (fake && pidsFile) {
  const pool = new Set<ReturnType<typeof Bun.spawn>>();
  setCompactorKiller(async () => {
    for (const p of pool) p.kill("SIGKILL");
    await Promise.all([...pool].map((p) => p.exited));
  });
  (booted.hub.memory as unknown as { compressor: unknown }).compressor = async () => {
    const p = Bun.spawn([fake, "exec", "-"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    pool.add(p);
    appendFileSync(pidsFile, `${p.pid}\n`);
    await p.exited;
    pool.delete(p);
    throw new Error("fake codex exec killed");
  };
}
console.log("CHILD_READY");
