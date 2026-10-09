import type { HarnessEvent, RunOpts } from "../harness/types";
import { detectSeatCommand, watchSeatOut } from "../harness/seats";
import type { AcpUpdate } from "./types";

export async function* toHarnessEvents(
  updates: AsyncIterable<AcpUpdate>,
  opts: RunOpts,
): AsyncIterable<HarnessEvent> {
  const seatWatchers: Array<AsyncGenerator<HarnessEvent>> = [];
  for await (const update of updates) {
    yield* mapOne(update, seatWatchers, opts);
    for (const w of seatWatchers) {
      const next = await w.next();
      if (!next.done && next.value) yield next.value;
    }
  }
}

function* mapOne(
  update: AcpUpdate,
  seatWatchers: Array<AsyncGenerator<HarnessEvent>>,
  opts: RunOpts,
): Generator<HarnessEvent> {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.text) yield { type: "text", text: update.text, seat: "claude" };
      break;
    case "tool_call": {
      yield {
        type: "tool",
        name: update.title,
        input: update.rawInput ?? {},
        id: update.toolCallId,
      };
      const cmd = typeof update.rawInput?.command === "string" ? update.rawInput.command : "";
      const detected = cmd ? detectSeatCommand(cmd) : null;
      if (detected) seatWatchers.push(watchSeatOut(detected.out, detected.seat, opts.signal));
      break;
    }
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
