# NCLI map

Personal hub: one infinite chat, a binary summary tree on top of an append-only log, and parallel forks. The agent inside this repo is supposed to change NCLI by following `ncli/skills/*/SKILL.md`.

## Modules

| Path | Contract |
| --- | --- |
| `src/index.ts` | `bootNcli()` then print the startup summary |
| `src/boot.ts` | one process: bus, views, HTTP, SSE, MCP. Fail if MCP does not answer initialize |
| `src/hub.ts` | main turn, live `Turn`, `/ncli` slash, `view://` open, pick harness/compressor |
| `src/server.ts` | static + `/mcp` + `/api/message` `/api/stop` `/api/harness` `/api/forks` `/api/events` `/api/state`. `idleTimeout: 0` for SSE |
| `src/memory/store.ts` | log + OptChat tree; `pump()` is background |
| `src/memory/sdk-compact.ts` | compaction ONLY, via `@cursor/sdk`. Auth is `NCLI_CURSOR_API_KEY` from `~/.config/ncli/secrets.env` or the process env. Never used by the Cursor seat |
| `src/memory/cursor-compact.ts` | batch / cache / 60k cap. Calls the SDK runner. CLI `--print` is a marked fallback |
| `src/secrets.ts` | load `~/.config/ncli/secrets.env`. Process env wins. Never log the key |
| `src/memory/cli-config.ts` | snapshot+restore `~/.cursor/cli-config.json`. Warn, never silent-repair |
| `src/memory/assemble.ts` | system prompt (master + skills index + view doc) |
| `src/forks/manager.ts` | one runtime per fork: memory, harness, optional worktree, merge line |
| `src/views/registry.ts` | load `views/*.ts` by default export; watch = hot reload |
| `src/views/types.ts` | `ViewPlugin` / `createFork` / `applyAction` / `render` |
| `src/acp/types.ts` | `AcpAdapter` → `AcpUpdate` (in-process ACP shape, not a vendor SDK) |
| `src/acp/*.ts` | CLI wrappers (`claude -p`, `cursor-agent --model NCLI_CURSOR_MODEL acp`, `codex exec --json` with `--model` only when `NCLI_CODEX_MODEL` is set). The Cursor seat never imports `@cursor/sdk` |
| `src/harness/*.ts` | `HarnessEvent` stream; `child-env` strips Anthropic, `CURSOR_API_KEY`, and `NCLI_CURSOR_API_KEY` |
| `src/live/parse.ts` + `frame.ts` | ` ```ncli kind ` fences → sandboxed iframe |
| `src/live/turn.ts` | one `Turn` / `TurnStep` timeline from harness events |
| `src/live/markdown.ts` | streaming-safe Markdown to HTML |
| `src/live/shimmer.ts` | skeleton for an open live fence |
| `src/live/pills.ts` | which forks sit on the right rail, and their CSS classes |
| `src/config.ts` | env; memory and compaction knobs |
| `src/skills/` + `ncli/skills/` | catalog injected on every spawn; pstack under `ncli/skills/pstack/`; emil under `ncli/skills/emil/` |
| `ncli/mcp.json` | the only MCP registry; injected per spawn, never into ~/.claude ~/.codex ~/.cursor |
| `src/mcp/` | Streamable HTTP `ncli` on `/mcp` (memory + bus + control). Token per spawn. No shim process |
| `src/bus/` | ncli-bus: unix socket + in-memory tickets. `ask`/`wait`/`post`/`inbox`/`read` |
| `public/` | chat UI, shortcuts rail, review modal |

## Extension points (one line each)

- **View / mode** — one file in `views/`. Registry picks it up. Open with `view://id`.
- **Harness** — `AcpAdapter` in `src/acp/<id>.ts`, then a case in `pickHarness` + `HarnessKind`.
- **Render kind** — add to `LiveKind`, `frameHtml`, and the matching regex in `public/app.js`.
- **Memory** — env in `src/config.ts`; do not compact on the user turn.
- **Shortcut** — `needsUser` on the fork + glyph in `public/app.js`.
- **Delegate** — `ask(agent, prompt)` on ncli-bus, or a `view://` fork. No extra daemons.
- **Bus** — one socket on the NCLI server. On-demand children. Posts land on the next turn (optional Claude hook is a single socket call).
- **MCP / skill** — add once in `ncli/mcp.json` / `ncli/skills/`. Spawn writes an HTTP `type: "http"` entry with a bearer token. The Bun server is already listening on `/mcp`.
- **Main harness** — same view + tools + pstack. Claude quota → `NCLI_BACKUP` (default Codex) and retry.

Shipped views: `review`, `refino`, `live`. Scaffold: `bun run ncli new view foo` / `remove`. Skills: `bun run ncli skills`.
