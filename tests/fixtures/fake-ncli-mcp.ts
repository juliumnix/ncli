import { readFileSync } from "node:fs";

export const MCP_BLOCKED =
  "tentei consultar zoom e recall; ambos foram bloqueados porque exigem aprovação e esta sessão não permite aprovações";

export function wantsMemoryState(text: string): boolean {
  return /j[aá]\s+indexou\s+toda\s+a\s+mem[oó]ria/i.test(text);
}

export function claudeNcliApproved(argv: string[]): boolean {
  const i = argv.indexOf("--allowedTools");
  if (i < 0) return argv.some((a) => a === "mcp__ncli__*" || a.startsWith("mcp__ncli__"));
  const val = argv[i + 1] ?? "";
  return val === "mcp__ncli__*" || val.includes("mcp__ncli__");
}

export function codexNcliApproved(argv: string[]): boolean {
  const joined = argv.join(" ");
  if (/approval_policy\s*=\s*never/.test(joined)) return false;
  const approve = argv.some((a) => a.includes("default_tools_approval_mode=approve"));
  const tools = argv.find((a) => a.includes("enabled_tools="));
  return approve && Boolean(tools && tools.includes("recall") && tools.includes("zoom"));
}

export function mcpFromClaudeArgs(argv: string[]): { url: string; token: string } | null {
  const i = argv.indexOf("--mcp-config");
  const path = i >= 0 ? argv[i + 1] : "";
  if (!path) return null;
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers?: { ncli?: { url?: string; headers?: { Authorization?: string } } };
    };
    const url = json.mcpServers?.ncli?.url ?? "";
    const token = (json.mcpServers?.ncli?.headers?.Authorization ?? "").replace(/^Bearer\s+/i, "");
    return url && token ? { url, token } : null;
  } catch {
    return null;
  }
}

export function mcpFromCodexArgs(argv: string[]): { url: string; token: string } | null {
  let url = "";
  let token = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "-c") continue;
    const v = argv[i + 1] ?? "";
    if (v.startsWith("mcp_servers.ncli.url=")) url = v.slice("mcp_servers.ncli.url=".length);
    const auth = v.match(/http_headers\.Authorization=Bearer\s+(.+)$/);
    if (auth) token = auth[1] ?? "";
  }
  return url && token ? { url, token } : null;
}

export function mcpFromCursorServers(raw: unknown): { url: string; token: string } | null {
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    const s = item as { name?: string; url?: string; headers?: Array<{ name?: string; value?: string }> };
    if (s.name !== "ncli" || !s.url) continue;
    const auth = (s.headers ?? []).find((h) => /^authorization$/i.test(h.name ?? ""));
    const token = (auth?.value ?? "").replace(/^Bearer\s+/i, "");
    if (token) return { url: s.url, token };
  }
  return null;
}

export async function recallImportState(mcp: { url: string; token: string }): Promise<string> {
  const res = await fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "recall", arguments: { pattern: "histórico|import|index" } },
    }),
  });
  const json = (await res.json()) as {
    result?: { content?: Array<{ text?: string }> };
    error?: { message?: string };
  };
  return json.result?.content?.[0]?.text ?? json.error?.message ?? "No match.";
}

export function replyFromRecall(text: string): string {
  const pct = text.match(/(\d+)\s*%/);
  if (pct) return `consultei recall: a importação está em ${pct[1]}%`;
  return `consultei recall: ${text.slice(0, 240)}`;
}
