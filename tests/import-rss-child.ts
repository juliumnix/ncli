import { makeHub } from "./helpers";

const root = process.argv[2];
if (!root) throw new Error("usage: import-rss-child <claude-root>");

const { hub } = await makeHub({ importClaude: root, compactSkipTokens: 1_000_000 });
try {
  const result = await hub.applyImport("claude", undefined, { surface: true });
  process.stdout.write(`${JSON.stringify({
    rss: process.memoryUsage().rss,
    previewLines: result.preview.lines.length,
    applied: result.applied,
    filesScanned: result.filesScanned ?? 0,
  })}\n`);
} finally {
  hub.close();
}
process.exit(0);
