import type { AcpAdapter } from "../acp/types";
import { toHarnessEvents } from "../acp/map";
import type { Harness, HarnessEvent, RunOpts } from "./types";

export class AcpHarness implements Harness {
  readonly id: string;
  constructor(private readonly adapter: AcpAdapter) {
    this.id = adapter.id;
  }

  async *run(opts: RunOpts): AsyncIterable<HarnessEvent> {
    let text = "";
    try {
      for await (const ev of toHarnessEvents(this.adapter.run(opts), opts, this.id)) {
        if (ev.type === "text") text += ev.text;
        yield ev;
      }
      yield { type: "done", text };
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
