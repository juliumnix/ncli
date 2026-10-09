import { createConnection } from "node:net";
import type { WireMsg } from "./types";

export function busRpc(socketPath: string, msg: WireMsg, timeout = 60_000): Promise<WireMsg> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("bus rpc timeout"));
    }, timeout);
    sock.setEncoding("utf8");
    sock.once("connect", () => {
      sock.write(`${JSON.stringify(msg)}\n`);
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as WireMsg);
      } catch (err) {
        reject(err);
      }
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
