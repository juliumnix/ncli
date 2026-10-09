import type { RunOpts } from "../harness/types";
import type { AcpAdapter, AcpUpdate } from "./types";

export interface MockAcpScript {
  text?: string;
  chunks?: string[];
  tools?: Array<{ id: string; title: string; command?: string; input?: Record<string, unknown> }>;
  plan?: string[];
  permission?: { id: string; title: string };
}

export class MockAcpAdapter implements AcpAdapter {
  readonly id = "mock-acp";
  readonly prompts: string[] = [];
  constructor(private readonly scriptFor: (prompt: string) => MockAcpScript = defaultScript) {}

  async *run(opts: RunOpts): AsyncIterable<AcpUpdate> {
    this.prompts.push(opts.prompt);
    const script = this.scriptFor(opts.prompt);
    if (script.plan) yield { sessionUpdate: "plan", entries: script.plan };
    if (script.permission) {
      yield { sessionUpdate: "permission_request", toolCallId: script.permission.id, title: script.permission.title };
    }
    for (const tool of script.tools ?? []) {
      yield {
        sessionUpdate: "tool_call",
        toolCallId: tool.id,
        title: tool.title,
        rawInput: tool.input ?? (tool.command ? { command: tool.command } : {}),
      };
      yield { sessionUpdate: "tool_call_update", toolCallId: tool.id, content: "ok" };
    }
    const chunks = script.chunks ?? (script.text ? [script.text] : ["ok"]);
    for (const text of chunks) yield { sessionUpdate: "agent_message_chunk", text };
  }
}

function defaultScript(prompt: string): MockAcpScript {
  if (/pstack-codex/i.test(prompt)) {
    return {
      tools: [{ id: "bash-1", title: "Bash", command: "pstack-codex --out /tmp/ncli-codex --prompt-file x" }],
      text: "Consultei o Codex.",
    };
  }
  return { text: prompt.slice(-180) || "ok" };
}
