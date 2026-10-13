import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const logPath = process.env.FAKE_CODEX_LOG;
const argv = process.argv.slice(2);
if (logPath) {
  appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, argv, t: Date.now() })}\n`);
}

const stdinDash = argv.at(-1) === "-";
const resumeAt = argv.indexOf("resume");
const resumeId = resumeAt >= 0 && argv[resumeAt + 1] && argv[resumeAt + 1] !== "-" ? argv[resumeAt + 1]! : "";
const model = process.env.FAKE_CODEX_MODEL || "gpt-5.4";
const threadId = resumeId || process.env.FAKE_CODEX_THREAD || randomUUID();
const delayInit = Number(process.env.FAKE_CODEX_INIT_MS ?? "0") || 0;
const delayToken = Number(process.env.FAKE_CODEX_TOKEN_MS ?? "0") || 0;
const reply = process.env.FAKE_CODEX_REPLY ?? "oi";

function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function turn(): Promise<void> {
  if (delayInit) await Bun.sleep(delayInit);
  emit({ type: "thread.started", thread_id: threadId, thread: { id: threadId, model } });
  if (delayToken) await Bun.sleep(delayToken);
  emit({ type: "item.completed", item: { id: "m1", type: "agent_message", text: reply } });
  emit({ type: "turn.completed" });
}

if (!stdinDash) {
  await turn();
  process.exit(0);
}

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
}
if (!buf.trim() && process.env.FAKE_CODEX_REQUIRE_PROMPT === "1") process.exit(0);
await turn();
