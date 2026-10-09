import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { Bus } from "../src/bus/bus";
import { busRpc } from "../src/bus/client";
import { makeHub, tmpDir } from "./helpers";

function cfg(dataDir: string, extra: Record<string, number> = {}) {
  return loadConfig({
    dataDir,
    repo: dataDir,
    harness: "mock",
    busDepth: extra.busDepth ?? 1,
    busChildren: extra.busChildren ?? 4,
    busBudget: extra.busBudget ?? 8,
  });
}

async function ppidKids(pid: number): Promise<string[]> {
  const proc = Bun.spawn(["ps", "-o", "pid=,args=", "--ppid", String(pid)], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

test("idle bus adds zero extra processes and no live children", async () => {
  const dataDir = tmpDir("bus-idle");
  const before = await ppidKids(process.pid);
  const bus = new Bus({ cfg: cfg(dataDir) });
  await bus.listen();
  expect(existsSync(bus.socketPath)).toBe(true);
  expect(bus.liveChildren()).toBe(0);
  const after = await ppidKids(process.pid);
  const extra = after.filter((row) => !before.includes(row) && !row.includes("ps "));
  expect(extra).toEqual([]);
  bus.close();
  expect(existsSync(bus.socketPath)).toBe(false);
});

test("ask returns a ticket immediately and wait resolves from an in-memory promise", async () => {
  const dataDir = tmpDir("bus-ask");
  const times: number[] = [];
  const bus = new Bus({
    cfg: cfg(dataDir),
    runner: async (req) => {
      times.push(Date.now());
      return { text: `pong:${req.agent}:${req.prompt}` };
    },
  });
  const t0 = performance.now();
  const got = bus.ask("main", "codex", "ping the discount");
  expect("ticket" in got).toBe(true);
  if ("error" in got) throw new Error(got.error);
  const issued = performance.now() - t0;
  const tickets = await bus.wait(got.ticket, 2000);
  const ms = performance.now() - t0;
  console.log(`ncli-bus ask issue ${issued.toFixed(1)}ms · ask+wait ${ms.toFixed(1)}ms (mock runner)`);
  expect(issued).toBeLessThan(50);
  expect(ms).toBeLessThan(200);
  expect(tickets[0]?.status).toBe("done");
  expect(tickets[0]?.result).toContain("pong:codex:ping the discount");
  expect(bus.liveChildren()).toBe(0);
  expect(bus.ledger.some((l) => l.kind === "ask")).toBe(true);
  expect(bus.ledger.some((l) => l.kind === "reply")).toBe(true);
  bus.close();
});

test("ask/wait with a real bun child measures latency then the child exits", async () => {
  const dataDir = tmpDir("bus-child");
  const bus = new Bus({
    cfg: cfg(dataDir),
    runner: async (req) => {
      const proc = Bun.spawn(["bun", "-e", "process.stdout.write('child-pong')"], { stdout: "pipe", stderr: "pipe" });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      return { text: `${text}:${req.agent}` };
    },
  });
  await bus.listen();
  const t0 = performance.now();
  const got = bus.ask("main", "cursor", "hi");
  if ("error" in got) throw new Error(got.error);
  const tickets = await bus.wait(got.ticket, 5000);
  const ms = performance.now() - t0;
  console.log(`ncli-bus ask+wait with bun -e child ${ms.toFixed(1)}ms`);
  expect(tickets[0]?.result).toBe("child-pong:cursor");
  expect(bus.liveChildren()).toBe(0);
  bus.close();
});

test("unix socket ask/wait/post/inbox/read round-trip", async () => {
  const dataDir = tmpDir("bus-sock");
  const bus = new Bus({
    cfg: cfg(dataDir),
    runner: async () => ({ text: "via-socket" }),
  });
  const sock = await bus.listen();
  const ask = await busRpc(sock, { from: "main", to: "codex", kind: "ask", body: "sum this" });
  expect(ask.ticket).toBeTruthy();
  const waited = await busRpc(sock, {
    from: "main",
    kind: "event",
    op: "wait",
    ticket: ask.ticket,
    body: ask.ticket ?? "",
    timeout: 2000,
  });
  expect(waited.body).toContain("via-socket");
  await busRpc(sock, { from: "codex", to: "main", kind: "post", body: "looks good" });
  const inbox = await busRpc(sock, { from: "main", kind: "event", op: "inbox", body: "" });
  expect(inbox.body).toContain("looks good");
  const read = await busRpc(sock, { from: "main", kind: "event", op: "read", body: "sum" });
  expect(read.body).toContain("ask");
  bus.close();
});

test("posts are prepended to the next main-chat prompt", async () => {
  const { hub, harness } = await makeHub();
  try {
    hub.bus.post("codex", "main", "diff ok, member only");
    expect(hub.memory.log.some((m) => m.kind === "bus" && m.text.includes("Codex → NCLI"))).toBe(true);
    await hub.send("e aí?");
    const prompt = harness.lastPrompts.at(-1) ?? "";
    expect(prompt.startsWith("<inbox>")).toBe(true);
    expect(prompt).toContain("diff ok, member only");
  } finally {
    hub.close();
  }
});

test("max depth 1 blocks a nested ask; cycle is rejected at depth 2", async () => {
  const shallow = new Bus({ cfg: cfg(tmpDir("bus-d1"), { busDepth: 1 }), runner: async () => ({ text: "a" }) });
  const first = shallow.ask("main", "codex", "outer");
  if ("error" in first) throw new Error(first.error);
  const nested = shallow.ask("codex", "cursor", "inner", { parent: first.ticket });
  expect("error" in nested && nested.error.includes("profundidade")).toBe(true);
  await shallow.wait(first.ticket, 2000);
  shallow.close();

  const deep = new Bus({ cfg: cfg(tmpDir("bus-d2"), { busDepth: 2 }), runner: async () => ({ text: "b" }) });
  const a = deep.ask("main", "codex", "outer");
  if ("error" in a) throw new Error(a.error);
  const back = deep.ask("codex", "claude", "back to orchestrator", { parent: a.ticket });
  expect("error" in back && back.error.includes("ciclo")).toBe(true);
  const hop = deep.ask("codex", "cursor", "sideways", { parent: a.ticket });
  expect("ticket" in hop).toBe(true);
  if ("ticket" in hop) await deep.wait([a.ticket, hop.ticket], 2000);
  else await deep.wait(a.ticket, 2000);
  deep.close();
});

test("per-fork budget and max concurrent children", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const bus = new Bus({
    cfg: cfg(tmpDir("bus-cap"), { busChildren: 1, busBudget: 2 }),
    runner: async () => {
      await gate;
      return { text: "ok" };
    },
  });
  const a = bus.ask("review-1", "codex", "one");
  const b = bus.ask("review-1", "cursor", "two");
  expect("ticket" in a).toBe(true);
  expect("error" in b && b.error.includes("filhos")).toBe(true);
  const over = bus.ask("review-1", "claude", "three");
  expect("error" in over).toBe(true);
  release();
  if ("ticket" in a) await bus.wait(a.ticket, 2000);
  const c = bus.ask("review-1", "cursor", "after");
  expect("ticket" in c).toBe(true);
  if ("ticket" in c) await bus.wait(c.ticket, 2000);
  const d = bus.ask("review-1", "claude", "budget");
  expect("error" in d && d.error.includes("orçamento")).toBe(true);
  bus.close();
});
