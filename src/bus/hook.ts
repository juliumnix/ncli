#!/usr/bin/env bun
import { join } from "node:path";
import { loadConfig } from "../config";
import { busRpc } from "./client";

const cfg = loadConfig();
const sock = process.env.NCLI_BUS_SOCK ?? join(cfg.dataDir, "ncli-bus.sock");
const from = process.env.NCLI_SESSION ?? "main";

try {
  const t0 = performance.now();
  const r = await busRpc(sock, { from, kind: "event", op: "hook", body: "" }, 200);
  const ms = performance.now() - t0;
  if (ms > 10) console.error(`ncli-bus hook ${ms.toFixed(1)}ms`);
  const lines = JSON.parse(r.body || "[]") as Array<{ from: string; body: string }>;
  if (lines.length) {
    console.log(lines.map((l) => `${l.from}: ${l.body}`).join("\n"));
  }
} catch {
  process.exit(0);
}
