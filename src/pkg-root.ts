import { join } from "node:path";

export function packageRoot(): string {
  return join(import.meta.dir, "..");
}
