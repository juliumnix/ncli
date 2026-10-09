export function formatRpcError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; code?: unknown; data?: unknown };
    const msg = typeof o.message === "string" ? o.message : "";
    const code = o.code == null ? "" : String(o.code);
    const data = formatData(o.data);
    const parts = [code && `RPC ${code}`, msg, data].filter(Boolean);
    return new Error(parts.join(": ") || JSON.stringify(err));
  }
  return new Error(String(err));
}

function formatData(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return "";
  }
}
