import { Agent } from "@cursor/sdk";
import { compactSdkKey, missingCompactKeyMessage } from "../secrets";
import { listCompactCatalog, resolveCompactModel } from "./compact-model";

export type SdkCompactFn = (prompt: string, model: string, apiKey: string) => Promise<string>;

export function isSdkUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Cannot find module ['"]@cursor\/sdk['"]|ERR_MODULE_NOT_FOUND|@cursor\/sdk/i.test(msg);
}

export async function runCursorSdkCompact(
  prompt: string,
  model: string,
  apiKey: string,
  cwd: string,
): Promise<string> {
  const catalog = await listCompactCatalog(apiKey);
  const choice = resolveCompactModel(catalog, model);
  const result = await Agent.prompt(prompt, {
    apiKey,
    model: { id: choice.id, params: choice.params.length ? choice.params : undefined },
    local: { cwd, settingSources: [] },
  });
  if (result.status === "error") {
    throw new Error("cursor-sdk compact run failed");
  }
  const text = typeof result.result === "string" ? result.result.trim() : "";
  if (!text) throw new Error("cursor-sdk compact returned no text");
  return text;
}

export function compactSdkStatus(env: Record<string, string | undefined> = process.env): "ok" | "missing-key" {
  return compactSdkKey(env) ? "ok" : "missing-key";
}

export function requireCompactSdkKey(env: Record<string, string | undefined> = process.env): string {
  const key = compactSdkKey(env);
  if (!key) throw new Error(missingCompactKeyMessage());
  return key;
}
