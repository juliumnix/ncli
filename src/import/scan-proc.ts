import { runImportScan } from "./scan";
import type { ImportScanIn, ImportScanOut } from "./protocol";

let waiting: (() => void) | undefined;
const stop = new AbortController();

function send(msg: ImportScanOut): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function waitPull(): Promise<void> {
  return new Promise((resolve) => {
    waiting = resolve;
  });
}

function onIn(msg: ImportScanIn): void {
  switch (msg.type) {
    case "pull":
      waiting?.();
      waiting = undefined;
      return;
    case "stop":
      stop.abort();
      waiting?.();
      waiting = undefined;
      return;
    case "run":
      void runImportScan(msg, send, waitPull, stop.signal)
        .catch((err) => {
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          waiting?.();
          waiting = undefined;
        });
      return;
    default: {
      const _n: never = msg;
      send({ type: "error", message: `unknown scan in: ${JSON.stringify(_n)}` });
    }
  }
}

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let nl = buf.indexOf("\n");
  while (nl >= 0) {
    const raw = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (raw) onIn(JSON.parse(raw) as ImportScanIn);
    nl = buf.indexOf("\n");
  }
}
