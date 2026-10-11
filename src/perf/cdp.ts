import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function chromePath(): string | undefined {
  const fromEnv = process.env.NCLI_PERF_CHROME?.trim();
  if (fromEnv) return fromEnv;
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const hit = Bun.which(bin);
    if (hit) return hit;
  }
  return undefined;
}

interface CdpPending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class CdpSession {
  private nextId = 0;
  private readonly pending = new Map<number, CdpPending>();
  private sessionId: string | undefined;

  constructor(private readonly ws: WebSocket) {
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        error?: { message?: string };
        result?: unknown;
        method?: string;
        params?: { sessionId?: string };
      };
      if (msg.id == null) return;
      const wait = this.pending.get(msg.id);
      if (!wait) return;
      this.pending.delete(msg.id);
      if (msg.error) wait.reject(new Error(msg.error.message ?? "cdp error"));
      else wait.resolve(msg.result);
    });
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++this.nextId;
    const body: Record<string, unknown> = { id, method, params: params ?? {} };
    if (this.sessionId) body.sessionId = this.sessionId;
    const result = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(body));
    });
    return result as T;
  }

  async attachPage(url: string): Promise<void> {
    const created = await this.send<{ targetId: string }>("Target.createTarget", { url });
    const attached = await this.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    });
    this.sessionId = attached.sessionId;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result?: { value?: T; description?: string }; exceptionDetails?: { text?: string } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "evaluate failed");
    }
    return result.result?.value as T;
  }

  async screenshot(): Promise<Uint8Array> {
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    return Uint8Array.from(Buffer.from(shot.data, "base64"));
  }

  close(): void {
    this.ws.close();
  }
}

export interface ChromeDriver {
  session: CdpSession;
  close(): void;
}

export async function launchChrome(port: number): Promise<ChromeDriver> {
  const bin = chromePath();
  if (!bin) throw new Error("chrome not found");
  const profile = mkdtempSync(join(tmpdir(), "ncli-perf-chrome-"));
  const proc = Bun.spawn(
    [
      bin,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const version = await waitJson<{ webSocketDebuggerUrl: string }>(`http://127.0.0.1:${port}/json/version`, 8000);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("chrome websocket failed")));
  });
  const session = new CdpSession(ws);
  return {
    session,
    close() {
      session.close();
      proc.kill();
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    },
  };
}

async function waitJson<T>(url: string, ms: number): Promise<T> {
  const start = Date.now();
  let last = "not started";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.json()) as T;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(80);
  }
  throw new Error(`chrome debug port did not come up: ${last}`);
}
