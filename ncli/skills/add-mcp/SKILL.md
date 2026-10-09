---
name: add-mcp
description: Register an MCP server once in ncli/mcp.json. NCLI injects it per spawn. Never write ~/.claude, ~/.codex, or ~/.cursor.
---

# Add an MCP server

One registry: `ncli/mcp.json`. The `ncli` server is built-in (memory + bus + control) and only exists while the NCLI process is running. Extra servers go in the same file.

## Do

Add an entry:

```json
{
  "mcpServers": {
    "ncli": { "...": "leave this" },
    "example": {
      "command": "npx",
      "args": ["-y", "some-mcp"],
      "env": {}
    }
  }
}
```

Use `${NCLI_BIN}`, `${NCLI_ROOT}`, `${NCLI_BUS_SOCK}`, `${NCLI_SESSION}`, `${NCLI_DATA}` if the server must talk to this hub.

On the next spawn NCLI writes a **temp** config under `data/spawn/<session>/` and passes `--mcp-config` (Claude), `-c mcp_servers.*` (Codex), or `session/new` mcpServers / worktree `.cursor/mcp.json` (Cursor). It never edits the user's global config.

## Check

```bash
bun test tests/mcp-inject.test.ts
```

Confirm the written path is under `data/spawn/` and not under `$HOME/.claude`, `$HOME/.codex`, or `$HOME/.cursor`.
