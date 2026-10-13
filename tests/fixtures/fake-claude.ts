import { appendFileSync } from "node:fs";
import {
  claudeNcliApproved,
  MCP_BLOCKED,
  mcpFromClaudeArgs,
  recallImportState,
  replyFromRecall,
  wantsMemoryState,
} from "./fake-ncli-mcp";

const logPath = process.env.FAKE_CLAUDE_LOG;
if (logPath) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), t: Date.now() })}\n`,
  );
}

const args = process.argv;
const streamIn = args.includes("--input-format");
const modelFlag = args.indexOf("--model");
const model =
  process.env.FAKE_CLAUDE_MODEL ||
  (modelFlag >= 0 ? args[modelFlag + 1] : undefined) ||
  "claude-opus-4-5";
const delayInit = Number(process.env.FAKE_CLAUDE_INIT_MS ?? "0") || 0;
const delayToken = Number(process.env.FAKE_CLAUDE_TOKEN_MS ?? "0") || 0;
const reply = process.env.FAKE_CLAUDE_REPLY ?? "oi";

function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function promptOf(line: string): string {
  try {
    const msg = JSON.parse(line) as { message?: { content?: Array<{ text?: string }> } };
    return (msg.message?.content ?? []).map((c) => c.text ?? "").join("\n");
  } catch {
    return line;
  }
}

async function answer(prompt: string): Promise<string> {
  if (!wantsMemoryState(prompt)) return reply;
  if (!claudeNcliApproved(args.slice(2))) return MCP_BLOCKED;
  const mcp = mcpFromClaudeArgs(args);
  if (!mcp) return MCP_BLOCKED;
  return replyFromRecall(await recallImportState(mcp));
}

async function turn(prompt = ""): Promise<void> {
  const text = await answer(prompt);
  if (delayInit) await Bun.sleep(delayInit);
  emit({ type: "system", subtype: "init", model });
  if (delayToken) await Bun.sleep(delayToken);
  emit({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  emit({ type: "result", result: text, is_error: false });
}

if (!streamIn) {
  await turn();
  process.exit(0);
}

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    await turn(promptOf(line));
  }
}
