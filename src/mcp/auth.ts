import { randomBytes } from "node:crypto";

export interface McpToken {
  session: string;
  ticket?: string;
}

export class McpGate {
  private tokens = new Map<string, McpToken>();

  mint(session: string, ticket?: string): string {
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, { session, ticket });
    return token;
  }

  lookup(token: string | undefined): McpToken | undefined {
    if (!token) return undefined;
    return this.tokens.get(token);
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }
}

export function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization") ?? req.headers.get("x-ncli-token") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1]?.trim();
  if (header && !header.includes(" ")) return header.trim();
  const q = new URL(req.url).searchParams.get("token");
  return q?.trim() || undefined;
}
