import { seatOf } from "../agent";
import type { HarnessEvent, RunOpts } from "../harness/types";
import type { SeatId } from "../types";
import type { AcpUpdate } from "./types";

export async function* toHarnessEvents(
  updates: AsyncIterable<AcpUpdate>,
  _opts: RunOpts,
  harnessId?: string,
): AsyncIterable<HarnessEvent> {
  const seat = seatOf(harnessId);
  for await (const update of updates) {
    yield* mapOne(update, seat);
  }
}

function* mapOne(update: AcpUpdate, seat: SeatId): Generator<HarnessEvent> {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.text) yield { type: "text", text: update.text, seat };
      break;
    case "agent_thought_chunk":
      if (update.text) yield { type: "thinking", text: update.text, seat };
      break;
    case "model":
      if (update.model) yield { type: "model", model: update.model, seat };
      break;
    case "tool_call":
      yield {
        type: "tool",
        name: update.title,
        input: update.rawInput ?? {},
        id: update.toolCallId,
        seat,
      };
      break;
    case "tool_call_update":
      yield { type: "tool_result", id: update.toolCallId, content: update.content };
      break;
    case "plan":
      yield { type: "tool", name: "plan", input: { entries: update.entries }, id: "plan" };
      break;
    case "permission_request":
      yield { type: "tool", name: "permission", input: { title: update.title }, id: update.toolCallId };
      break;
    default: {
      const _n: never = update;
      void _n;
    }
  }
}
