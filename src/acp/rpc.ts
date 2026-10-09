export class NdjsonRpc {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private buf = "";
  onNotification: (method: string, params: unknown) => void = () => undefined;
  onRequest: (id: number, method: string, params: unknown) => void = () => undefined;

  constructor(
    private readonly stdin: { write: (data: string) => number | void; end: (err?: Error) => void },
    stdout: ReadableStream<Uint8Array>,
  ) {
    void this.read(stdout);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  respond(id: number, result: unknown): void {
    this.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  close(): void {
    try {
      this.stdin.end();
    } catch {
      /* closed */
    }
  }

  private async read(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.buf += decoder.decode(value, { stream: true });
        const lines = this.buf.split("\n");
        this.buf = lines.pop() ?? "";
        for (const line of lines) this.handle(line);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handle(line: string): void {
    if (!line.trim()) return;
    let msg: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const wait = this.pending.get(msg.id);
      if (!wait) return;
      this.pending.delete(msg.id);
      if (msg.error) wait.reject(msg.error);
      else wait.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      this.onRequest(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method) this.onNotification(msg.method, msg.params);
  }
}
