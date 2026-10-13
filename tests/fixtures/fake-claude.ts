import { appendFileSync } from "node:fs";

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

async function turn(): Promise<void> {
  if (delayInit) await Bun.sleep(delayInit);
  emit({ type: "system", subtype: "init", model });
  if (delayToken) await Bun.sleep(delayToken);
  emit({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: reply } },
  });
  emit({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });
  emit({ type: "result", result: reply, is_error: false });
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
    await turn();
  }
}
