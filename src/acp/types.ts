import type { RunOpts } from "../harness/types";

export type AcpUpdate =
  | { sessionUpdate: "agent_message_chunk"; text: string }
  | { sessionUpdate: "tool_call"; toolCallId: string; title: string; rawInput?: Record<string, unknown> }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; content: string }
  | { sessionUpdate: "plan"; entries: string[] }
  | { sessionUpdate: "permission_request"; toolCallId: string; title: string };

export interface AcpAdapter {
  id: string;
  run(opts: RunOpts): AsyncIterable<AcpUpdate>;
}
