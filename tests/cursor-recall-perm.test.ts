import { expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { CursorAcpAdapter } from "../src/acp/cursor";
import { loadConfig } from "../src/config";
import { AcpHarness } from "../src/harness/acp";
import { tmpDir } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures/fake-cursor");

test("Cursor ACP auto-allows ncli recall and the fake replies with import percent", async () => {
  chmodSync(FAKE, 0o755);
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { method?: string; params?: { name?: string } };
      hits.push(body.method ?? "");
      if (body.method === "tools/call" && body.params?.name === "recall") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "#3 note: Ainda estou trazendo o histórico (42%)." }] },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    },
  });
  const dataDir = tmpDir("cursor-perm-e2e");
  const cfg = loadConfig({ dataDir, repo: dataDir, acpCursor: FAKE, cursorBin: FAKE, compactBackend: "mock" });
  const adapter = new CursorAcpAdapter(cfg);
  const events: string[] = [];
  try {
    for await (const ev of new AcpHarness(adapter).run({
      prompt: "você já indexou toda a memória?",
      cwd: dataDir,
      session: "main",
      mcpServers: [
        {
          name: "ncli",
          type: "http",
          url: `http://127.0.0.1:${server.port}/mcp`,
          headers: { Authorization: "Bearer tok" },
        },
      ],
    })) {
      if (ev.type === "text") events.push(ev.text);
    }
    expect(events.join("")).toContain("42%");
    expect(hits).toContain("tools/call");
  } finally {
    adapter.close();
    server.stop();
  }
});
