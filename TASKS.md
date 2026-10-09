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

B. [x] Long messages stay readable
   Chat auto-scrolls while streaming, stops if the user scrolled up.
   Bubble never clips. Composer never covers the last lines.

C. [x] Output contract + stream separators + real Markdown
   Preserve separators between text blocks so sentences do not glue (`causa.Causa`).
   Render headings, lists, and code. System prompt: short status first, progress on the live timeline, concise final answer.

## Then

E. [x] Vendor Emil Kowalski MIT design skills (`ncli/skills/emil/`) + sync script + harness index
F. [ ] Visual redesign (Telegram-like dark, Emil motion rules) + review checklist + screenshots + PR
   Memory / compaction drawer is part of this pass, not a later polish.
   Replace raw `i+1|kind: text` lines with a tree a person can read.
   Recent messages stay verbatim. Older ones group into compacted levels (2× / 4× / 8× …)
   as cards with author avatar, time range, and a plain-language summary.
   Pending nodes show the original text with a subtle shimmer while Haiku summarizes,
   then crossfade into the summary.
   A small header shows nodes compacted, tokens today vs budget, and the model.
   Click a card to zoom into its original messages.
   Motion follows Emil (short ease-out, transform/opacity only, layout-aware
   expand/collapse, prefers-reduced-motion).
   Keep the raw text view as a debug toggle.
   Before/after screenshots of the drawer.
