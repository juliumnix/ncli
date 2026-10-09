# NCLI tasks

Work one item at a time. Finish, test, commit, then move on.

## Julio real-use (first)

A. [x] Cursor via NCLI is broken
   ACP `session/new` mcpServers must keep `type`/`url`/`headers` (HTTP) and `env` as `[{name,value}]`.
   `rpc.ts` must surface the real JSON-RPC error, not `[object Object]`.
   Bus `timeout` accepts seconds (Claude sent `120`) or milliseconds; do not treat `120` as 120ms.
   Integration test: when `cursor-agent acp` / `codex` exist, `ask`/`wait` answers with ncli MCP injected.

D. [x] Memory view + compact batch (raised)
   Fix duplicated index (`23+1|23+1|…`). While a node is pending, show truncated raw text, not `(not summarized yet: zoom it)`.
   Batch pending nodes (debounce a few seconds, up to `NCLI_COMPACT_BATCH`, under the 60k cap). Pump must start a wave together so Haiku is not one node per ~12s call.
   Live timeline steps must not become memory messages. Keep user / talk / bus / seat / merge / note. At most one `tools:` line per turn.
   Status and error summaries are time-stamped and go stale. The agent verifies live tools over memory. Tests for all of the above.

B. [ ] Long messages stay readable
   Chat auto-scrolls while streaming, stops if the user scrolled up.
   Bubble never clips. Composer never covers the last lines.

C. [ ] Output contract + stream separators + real Markdown
   Preserve separators between text blocks so sentences do not glue (`causa.Causa`).
   Render headings, lists, and code. System prompt: short status first, progress on the live timeline, concise final answer.

## Then

E. [ ] Vendor Emil Kowalski MIT design skills (`ncli/skills/emil/`) + sync script + harness index
F. [ ] Visual redesign (Telegram-like dark, Emil motion rules) + review checklist + screenshots + PR
