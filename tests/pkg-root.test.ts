import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot, loadConfig } from "../src/config";
import { packageRoot } from "../src/pkg-root";
import { loadMcpRegistry } from "../src/mcp/registry";
import { codexMcpFlags } from "../src/mcp/inject";
import { resolveServers, spawnVars } from "../src/mcp/registry";
import { tmpDir } from "./helpers";

test("dataRoot stays NCLI_ROOT or cwd, and the package root is a separate path", () => {
  const cwd = tmpDir("cwd-root");
  const pinned = tmpDir("pinned-root");
  expect(dataRoot({ NCLI_ROOT: pinned }, cwd)).toBe(pinned);
  expect(dataRoot({}, cwd)).toBe(cwd);
  const cfg = loadConfig({ dataDir: tmpDir("cfg-data") });
  expect(cfg.ncliRoot).toBe(process.env.NCLI_ROOT ?? process.cwd());
  expect(cfg.pkgRoot).toBe(packageRoot());
  expect(cfg.pkgRoot).not.toBe(cfg.dataDir);
});

test("loadMcpRegistry falls back to the package when the data root has no ncli/mcp.json", () => {
  const empty = tmpDir("no-registry");
  const reg = loadMcpRegistry(empty);
  expect(reg.path).toBe(join(packageRoot(), "ncli/mcp.json"));
  expect(reg.servers.map((s) => s.name)).toEqual(["ncli"]);
  expect(reg.servers[0]?.type).toBe("http");
});

test("an explicit registry on the data root wins over the package copy", () => {
  const root = tmpDir("custom-registry");
  mkdirSync(join(root, "ncli"), { recursive: true });
  writeFileSync(
    join(root, "ncli/mcp.json"),
    JSON.stringify({ mcpServers: { extra: { command: "extra-mcp", args: ["serve"] } } }),
  );
  const reg = loadMcpRegistry(root);
  expect(reg.servers.map((s) => s.name)).toEqual(["extra"]);
});

test("codex injection sets mcp_servers.ncli.enabled=true", () => {
  const servers = resolveServers(
    loadMcpRegistry(packageRoot()),
    spawnVars(loadConfig({ dataDir: tmpDir("en") }), "main", {
      NCLI_MCP_URL: "http://127.0.0.1:9/mcp",
      NCLI_MCP_TOKEN: "tok",
    }),
  );
  const flags = codexMcpFlags(servers);
  expect(flags).toContain("-c");
  expect(flags).toContain("mcp_servers.ncli.enabled=true");
});
