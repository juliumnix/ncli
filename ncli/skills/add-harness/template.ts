import { childEnv } from "../harness/child-env";
import type { RunOpts } from "../harness/types";
import type { AcpAdapter, AcpUpdate } from "./types";

export class {{Id}}CliAdapter implements AcpAdapter {
  readonly id = "{{id}}";
  constructor(private readonly bin: string) {}

  async *run(opts: RunOpts): AsyncIterable<AcpUpdate> {
    const proc = Bun.spawn([this.bin, opts.prompt], {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: childEnv(process.env, { allowAnthropicKey: false }),
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        if (opts.signal?.aborted) {
          proc.kill();
          break;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          yield { sessionUpdate: "agent_message_chunk", text: `${line}\n` };
        }
      }
    } finally {
      reader.releaseLock();
    }
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(err.trim() || `${this.bin} exited ${code}`);
    }
  }
}
