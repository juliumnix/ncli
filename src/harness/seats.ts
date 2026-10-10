import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SeatId } from "../types";

export function mockWriteSeat(outPath: string, seat: SeatId, text: string, logLines: string[]): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(`${outPath}.log`, logLines.join("\n") + "\n", "utf8");
  writeFileSync(outPath, text, "utf8");
  writeFileSync(`${outPath}.json`, JSON.stringify({ seat, mock: true }), "utf8");
}
