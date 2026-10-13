export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

const READ: McpToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export const NCLI_TOOLS: McpToolDef[] = [
  {
    name: "zoom",
    description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
    inputSchema: { type: "object", properties: { id: { type: "number" }, n: { type: "number" } }, required: ["id", "n"] },
    annotations: READ,
  },
  {
    name: "date",
    description: "The date and time of message id.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    annotations: READ,
  },
  {
    name: "recall",
    description: "Search the raw log with a regex.",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    annotations: READ,
  },
  {
    name: "supersede",
    description: "Mark earlier message id(s) as replaced. The latest word is the truth. old is one id or an array. new is the replacement message id. Omit new to use this note. reason is required.",
    inputSchema: {
      type: "object",
      properties: { old: {}, new: { type: "number" }, reason: { type: "string" } },
      required: ["old", "reason"],
    },
  },
  {
    name: "ncli.render",
    description: "Show a live preview in chat. kind is mermaid, html, react, url, ui, or 3d. ui is an interactive mini-app. 3d is an in-chat three.js scene via ncli3d. Repeat the returned fence in your reply.",
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
        spark: { type: "string" },
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
    description: "Short message to a seat, spark id, or main.",
    inputSchema: { type: "object", properties: { to: { type: "string" }, msg: { type: "string" } }, required: ["to", "msg"] },
  },
  { name: "inbox", description: "Drain pending posts for this session.", inputSchema: { type: "object", properties: {} }, annotations: READ },
  {
    name: "read",
    description: "Search the ncli-bus ledger.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    annotations: READ,
  },
  {
    name: "open_spark",
    description: "Open a view:// spark. params is a query string (pr=482) or object.",
    inputSchema: {
      type: "object",
      properties: { view: { type: "string" }, params: {} },
      required: ["view"],
    },
  },
  {
    name: "close_spark",
    description: "Finish and merge a spark back into the main chat.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, summary: { type: "string" } }, required: ["id"] },
  },
  { name: "list_views", description: "List view:// plugins.", inputSchema: { type: "object", properties: {} }, annotations: READ },
  { name: "list_sparks", description: "List open sparks.", inputSchema: { type: "object", properties: {} }, annotations: READ },
  {
    name: "switch_harness",
    description: "Switch the main harness (claude, codex, cursor, mock). Same memory, tools, and skills continue.",
    inputSchema: { type: "object", properties: { harness: { type: "string" } }, required: ["harness"] },
  },
  {
    name: "budget",
    description: "Memory view budget: bytes, lines, levels.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
  },
];

export const BUS_TOOL_NAMES = ["ask", "wait", "post", "inbox", "read"] as const;
