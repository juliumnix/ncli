export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const NCLI_TOOLS: McpToolDef[] = [
  {
    name: "zoom",
    description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
    inputSchema: { type: "object", properties: { id: { type: "number" }, n: { type: "number" } }, required: ["id", "n"] },
  },
  {
    name: "date",
    description: "The date and time of message id.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "recall",
    description: "Search the raw log with a regex.",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
  {
    name: "ncli.render",
    description: "Show a live preview in chat. kind is mermaid, html, react, url, or ui. ui is an interactive mini-app. Repeat the returned fence in your reply.",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string" }, source: { type: "string" } },
      required: ["kind", "source"],
    },
  },
  {
    name: "ask",
    description: "Spawn a one-shot coding agent (claude, codex, or cursor). Returns a ticket. Then wait(ticket).",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        prompt: { type: "string" },
        fork: { type: "string" },
        mode: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["agent", "prompt"],
    },
  },
  {
    name: "wait",
    description: "Block until ask tickets finish. In-memory promise; no polling.",
    inputSchema: {
      type: "object",
      properties: { ticket: {}, tickets: { type: "array", items: { type: "string" } }, timeout: { type: "number" } },
    },
  },
  {
    name: "post",
    description: "Short message to a seat, fork id, or main.",
    inputSchema: { type: "object", properties: { to: { type: "string" }, msg: { type: "string" } }, required: ["to", "msg"] },
  },
  { name: "inbox", description: "Drain pending posts for this session.", inputSchema: { type: "object", properties: {} } },
  {
    name: "read",
    description: "Search the ncli-bus ledger.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "open_fork",
    description: "Open a view:// fork. params is a query string (pr=482) or object.",
    inputSchema: {
      type: "object",
      properties: { view: { type: "string" }, params: {} },
      required: ["view"],
    },
  },
  {
    name: "close_fork",
    description: "Finish and merge a fork back into the main chat.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, summary: { type: "string" } }, required: ["id"] },
  },
  { name: "list_views", description: "List view:// plugins.", inputSchema: { type: "object", properties: {} } },
  { name: "list_forks", description: "List open forks.", inputSchema: { type: "object", properties: {} } },
  {
    name: "switch_harness",
    description: "Switch the main harness (claude, codex, cursor, mock). Same memory, tools, and skills continue.",
    inputSchema: { type: "object", properties: { harness: { type: "string" } }, required: ["harness"] },
  },
  {
    name: "budget",
    description: "Memory view budget: bytes, lines, levels.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const BUS_TOOL_NAMES = ["ask", "wait", "post", "inbox", "read"] as const;
