# NCLI

Personal local hub that drives coding-agent CLIs. One infinite chat. Forks run in parallel, each with its own memory, harness process, and git worktree. Claude answers in the main thread. Codex and Cursor show up as their own messages when the orchestrator actually consults them.

ACP in this repo is **NCLI's internal session contract**, not a vendor SDK. Claude runs as the unmodified official CLI (`claude -p`). There is no Agent SDK, no Zed `claude-code-acp`, no harukitosa bridge, and no `@anthropic-ai/claude-agent-sdk` dependency.

## How to run

You need [Bun](https://bun.sh) 1.1+.

```bash
bun install
bun dev
```

Open http://127.0.0.1:47231. `bun dev` starts in mock harness with a short demo conversation so the page is usable without Claude Code.

Talk to a real Claude Code install (your own `claude` login; NCLI never touches OAuth tokens):

```bash
NCLI_HARNESS=claude bun start
```

Optional env:

| Variable | Default | Meaning |
| --- | --- | --- |
| `NCLI_HARNESS` | `auto` | `claude`, `cursor`, `codex`, `mock`, or `auto` (`auto` uses `claude` if the binary exists) |
| `NCLI_BACKUP` | `codex` | main harness to switch to when Claude reports quota/rate-limit |
| `NCLI_DATA` | `./data` | log + tree + forks |
| `NCLI_PORT` | `47231` | HTTP port |
| `NCLI_REPO` | cwd | repo used for `git worktree add` |
| `NCLI_VIEW` | `2500` | view budget in bytes (demo-low) |
| `NCLI_NODE` | `280` | summary line target |
| `NCLI_GH` | `auto` | `real` uses `gh`; `mock` uses `fixtures/gh` |
| `NCLI_DEMO` | unset | `1` seeds the v4 demo on an empty log |
| `NCLI_FANOUT` | unset | `1` would launch pstack-codex/cursor from NCLI (not the default) |
| `NCLI_BUS_DEPTH` | `1` | max nested `ask` (set `2` to allow one hop) |
| `NCLI_BUS_CHILDREN` | `4` | max concurrent on-demand CLIs |
| `NCLI_BUS_BUDGET` | `8` | `ask` calls per fork |
| `NCLI_CLAUDE` | `claude` | unmodified Claude Code binary |
| `NCLI_CLAUDE_MODEL` | unset | passed as `--model` |
| `NCLI_CLAUDE_API_KEY` | unset | `1` lets the child keep `ANTHROPIC_API_KEY`; default is strip |
| `NCLI_CURSOR` | `cursor-agent` | Cursor CLI for compaction (`--print`) |
| `NCLI_ACP_CURSOR` | `cursor-agent acp` | first-party Cursor ACP entrypoint only |
| `NCLI_CODEX` | `codex` | Codex binary; NCLI wraps `codex exec --json` |
| `NCLI_COMPACT` | `auto` | `cursor`, `claude`, `mock`; `auto` is mock under `bun dev`, Cursor CLI otherwise |
| `NCLI_COMPACT_MODEL` | `claude-haiku-5-5-low` | model for Cursor `--print` compaction |
| `NCLI_COMPACT_BATCH` | `6` | summaries per Cursor call |
| `NCLI_COMPACT_SKIP` | `80` | skip the CLI when the node is already this many tokens or fewer |
| `NCLI_COMPACT_BUDGET` | `250000` | daily token budget for compaction |

## Harness boundary (ACP-shaped, in-process)

NCLI adapters implement the same session updates (`agent_message_chunk`, `tool_call`, `plan`, `permission_request`) and map them to harness events. Shape follows the public [Agent Client Protocol](https://agentclientprotocol.com/protocol/v2/overview) so Cursor's first-party ACP process can plug in. Claude and Codex do **not** speak ACP on the wire.

| Seat | Real command | Tests |
| --- | --- | --- |
| Claude | unmodified `claude -p --output-format stream-json --verbose` plus `--model`, `--mcp-config --strict-mcp-config`, `--resume` / `--session-id` (UUID), `--system-prompt-file`. Prompt is the last argument. Docs: [CLI reference](https://code.claude.com/docs/en/cli-reference), [headless](https://code.claude.com/docs/en/headless), [sessions](https://code.claude.com/docs/en/sessions). | `MockAcpAdapter` in-process. `parseClaudeLine` on fixtures. Never spawn `claude`. |
| Cursor | first-party [`cursor-agent acp`](https://cursor.com/docs/cli/acp) / `agent acp` (JSON-RPC ndjson on stdio). Not `npx cursor-agent-acp`. | `cursorUpdate` + `NdjsonRpc` on a fake stream. |
| Codex | wrap [`codex exec --json`](https://developers.openai.com/codex/cli/slash-commands). OpenAI has not shipped a native ACP entrypoint; third-party `@agentclientprotocol/codex-acp` is out of scope. | `parseCodexLine` on fixtures. |

Child processes get a scrubbed env: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and similar keys are stripped. Opt in to the API key only with `NCLI_CLAUDE_API_KEY=1`. OAuth tokens are never passed through.

## Live content

Chat and the `view://live` modal render fenced blocks:

````
```ncli mermaid|html|react|url
source
```
````

Or MCP `ncli.render({kind, source})`. HTML/react land in an iframe with `sandbox="allow-scripts"` (no `allow-same-origin`) and a tight CSP on the `srcdoc` document. Mermaid is a tiny inline SVG so nothing is loaded from a CDN. `url` only allows `http:` / `https:`. Streaming draws a still-open fence as it arrives.

`bun dev` seeds one mermaid + html pair in chat and opens `view://live` (four previews). Open the modal from the right rail, or `?open=<fork-id>`.

## Compaction

The memory tree still compresses in the background and never blocks the user turn (`void memory.pump()`). The cheap path is Cursor CLI, mocked in tests:

```bash
cursor-agent --print --model claude-haiku-5-5-low --output-format json --trust "…"
```

Batch several nodes, skip tiny ones, cache by content hash, stop at the daily token budget, log tokens to `data/compact-log.jsonl`. `NCLI_COMPACT=claude` still exists for Haiku-via-`claude -p` if you want it; it is not the default.

## Hack NCLI from inside NCLI

The agent in the main chat is supposed to change this repo. One tree: `ncli/skills/<id>/SKILL.md` (pstack vendored in `ncli/skills/pstack/`). One MCP registry: `ncli/mcp.json`. NCLI translates both into each harness on spawn (`--mcp-config`, `-c mcp_servers.*`, or a fork worktree `.cursor/mcp.json`). It never writes `~/.claude`, `~/.codex`, or `~/.cursor`. Module map: `docs/ARCHITECTURE.md`.

```bash
bun run ncli skills
bun run ncli new view foo     # writes views/foo.ts, hot-reloads
bun run ncli remove view foo
```

Same commands as a slash in chat: `/ncli new view foo`. Shipped views: `review` (guided review), `refino` (pareceres + chips, merge at score ≥ 0.90), `live` (four sandboxed previews). Each view is one file in `views/` (`review` also uses `src/review/model.ts`). Example data is a fictional `acme/shop` PR.

## Memory tree

The chat log is append-only. A binary tree of one-line summaries sits on top of it (OptChat). Each turn sees a fixed-size view, oldest first, recent lines covering one message, older lines covering more. The agent zooms down a node when a summary is too coarse.

```bash
bun run seed        # ~300 synthetic messages, fact in #12
bun run demo:hop    # hop from the cover down to message #12
bun test tests/hop.test.ts
```

`demo:hop` uses the mock compressor. It does not call Claude or Cursor. To try the real Claude path, set `NCLI_HARNESS=claude` and send a question that needs an old fact. Claude Code gets `zoom` / `date` / `recall` / `ncli.render` through `--mcp-config` pointing at `bun run src/mcp/memory-zoom.ts`.

The drawer (☰) shows the current view, byte budget, and level mix (`16× 8× …`).

## Forks

Unlimited, in parallel. Mix reviews, refinos, and live. Each fork has:

- its own memory directory
- its own harness process
- a `git worktree add` when the view touches a repo
- cleanup on close

A fork that needs you (`needs_user`: question pending, ready for review, or the live preview hold) appears as a round avatar on the right, with an unread badge and a short label. Running forks stay off that rail. Clicking the avatar opens the fork modal (blurred chat behind it). Answering a refino option chip `POST`s `/api/forks/:id/act` to that fork. Refino also merges back into the main chat when score ≥ 0.90. When the agent finishes and does not need you, NCLI merges one summary line into the main chat.

## Seats (Claude / Codex / Cursor)

The UI is a normal single-assistant thread (Claude Code answers). If that process fans out, NCLI shows Codex and Cursor as smaller Telegram-style messages with their logos, immediately before Claude's reply.

How detection works, in order:

1. Parse `claude -p --output-format stream-json` tool events. A `Bash` command matching `pstack-codex` or `pstack-cursor --out <file>` starts a watcher on `<file>.log` and `<file>`.
2. Tests and `bun dev` use `MockHarness` / `MockAcpAdapter`, which emit seat or ACP events directly. They do not spawn `pstack-*`.

NCLI does not fan out the three CLIs on every turn. pstack-claude should call MCP `ask` / `wait` (ncli/skills/ncli-bus) instead of Bash `pstack-codex`. The NCLI server owns the child; it exits when the ticket completes. No bus watchers or pollers. `pstack-codex` / `pstack-cursor` still work if the orchestrator shells out. Direct NCLI fan-out remains `NCLI_FANOUT=1`.

Logos live in `public/icons/` (Simple Icons: Claude, OpenAI, Cursor).

## Tests

```bash
bun test
```

| File | What it proves | Real / mock |
| --- | --- | --- |
| `tests/acp.test.ts` | `claude -p` args, UUID `--resume`, env strip, mocked ACP session, Cursor/Codex parsers, no SDK deps | in-process mock; never spawn vendor CLIs |
| `tests/live.test.ts` | fences, SVG mermaid, sandbox/CSP, blocked `javascript:` URLs, `view://live` | fixtures |
| `tests/review-guide.test.ts` | chapter order, plan fallback, two-column line numbers, fold, active-file overlap, guided-review chrome | fixtures, mock CLI |
| `tests/compact-cursor.test.ts` | batch, cache, skip, daily budget, async, token log | injected runner; no `cursor-agent` |
| `tests/compaction.test.ts` | view stays under budget; short lines skip Haiku | mock compressor |
| `tests/context.test.ts` | cover tiles `[0,T)`; zoom | mock compressor |
| `tests/views.test.ts` | registry + hot load of `hello.ts`; review chapter order | fixtures, no `gh` |
| `tests/view-actions.test.ts` | refino chips → score ≥ 0.90 merge | mock CLI |
| `tests/fork-merge.test.ts` | `view://review?pr=482` waits, then `review #N` | mock CLI, fixture PR |
| `tests/concurrent-forks.test.ts` | three refinos at once, isolated worktrees and logs, all merge | real `git worktree`, mock CLI |
| `tests/hop.test.ts` | 300 messages, recover `#12` by hops | mock compressor |
| `tests/self-hack.test.ts` | skills in system prompt; add-view appears live; remove-view drops it | mock agent, real watch |
| `tests/bus.test.ts` | idle = 0 extra processes; ask/wait promise; post→next prompt; depth/cycle | mock CLI |
| `tests/mcp-inject.test.ts` | one ncli MCP; spawn files under data/; no global ~/.claude | temp dirs |
| `tests/fallback.test.ts` | Claude 429 → backup harness, announce, retry | mock |

Hot reload while the app is up: `bun run ncli new view hello`, then `view://hello`. `/ncli remove view hello` takes it away.

## Development

All development uses pstack. See `AGENTS.md` and `.cursor/rules/pstack.mdc`. Skills live in `ncli/skills/`. Sync vendored pstack with `bun run scripts/sync-pstack.ts`.
