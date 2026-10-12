# NCLI map

Personal hub: one infinite chat, a binary summary tree on top of an append-only log, and parallel sparks. The agent inside this repo is supposed to change NCLI by following `ncli/skills/*/SKILL.md`.

## Modules

| Path | Contract |
| --- | --- |
| `src/index.ts` | `bootNcli()` then print the startup summary |
| `src/boot.ts` | one process: bus, views, HTTP, SSE, MCP. Fail if MCP does not answer initialize |
| `src/hub.ts` | main turn, live `Turn`, `/ncli` slash, `view://` open, pick harness/compressor |
| `src/server.ts` | static + `/mcp` + `/api/message` `/api/stop` `/api/harness` `/api/sparks` `/api/import` `/api/events` `/api/state`. `idleTimeout: 0` for SSE |
| `src/import/` | Claude / Codex / Cursor JSONL → `user`/`talk`. Preview, apply, fingerprint ledger |
| `src/memory/store.ts` | log + OptChat tree; `pump()` builds nodes in the background; `settle()` waits for the visible cover only |
| `src/memory/spaces.ts` | `SpaceId` + one `Memory` per project / global / inbox; worktrees share `git-common-dir`. `spaceFor` is cached. MCP zoom/recall/date stay on current, global, or own spark |
| `src/memory/facts.ts` | append-only superseded index rebuilt from the log. Rejects `new<=old` and cycles. SUPERSEDED on zoom, recall, and n=1 view |
| `src/memory/recall.ts` | RecallEvent from successful callMcp, with space. verifyCitations needs same space + existing id |
| `src/memory/sdk-compact.ts` | compaction ONLY, via `@cursor/sdk`. Auth is `NCLI_CURSOR_API_KEY` from `~/.config/ncli/secrets.env` or the process env. Never used by the Cursor seat |
| `src/memory/cursor-compact.ts` | batch / cache / 60k cap. Calls the SDK runner. CLI `--print` is a marked fallback |
| `src/secrets.ts` | load `~/.config/ncli/secrets.env`. Process env wins. Never log the key |
| `src/memory/cli-config.ts` | snapshot+restore `~/.cursor/cli-config.json`. Warn, never silent-repair |
| `src/memory/assemble.ts` | system prompt (master + skills index + view doc) |
| `src/sparks/manager.ts` | one runtime per spark: memory, harness, optional worktree, structured `SparkResult` merge |
| `src/views/registry.ts` | load `views/*.ts` (loose) and `views/<id>/` packages; watch = hot reload |
| `src/views/types.ts` | `ViewPlugin` / `createSpark` / `applyAction` / `render` / `result` |
| `src/views/manifest.ts` | `ViewManifest` schema, exclusive skills, `FlowStep`, `SparkResult` |
| `src/views/pack.ts` | `ncli view add <path|git-url>` / `ncli view pack` |
| `src/acp/types.ts` | `AcpAdapter` → `AcpUpdate` (in-process ACP shape, not a vendor SDK) |
| `src/acp/*.ts` | CLI wrappers (`claude -p`, `cursor-agent --model NCLI_CURSOR_MODEL acp`, `codex exec --json` with `--model` only when `NCLI_CODEX_MODEL` is set). The Cursor seat never imports `@cursor/sdk` |
| `src/harness/*.ts` | `HarnessEvent` stream; `child-env` strips Anthropic, `CURSOR_API_KEY`, and `NCLI_CURSOR_API_KEY` |
| `src/live/parse.ts` + `frame.ts` + `ui-frame.ts` | ` ```ncli kind ` fences → sandboxed iframe. `ui` injects theme tokens, `ncliChart`, height/`send` host messages |
| `src/live/turn.ts` | one `Turn` / `TurnStep` timeline from harness events |
| `src/live/markdown.ts` | streaming-safe Markdown to HTML |
| `src/live/shimmer.ts` | skeleton for an open live fence |
| `src/live/pills.ts` | which sparks sit on the right rail, and their CSS classes |
| `src/config.ts` | env; memory and compaction knobs |
| `src/skills/` + `ncli/skills/` | runtime catalog injected on every spawn (NCLI skills + Emil for UI). `ncli/skills/pstack/` is vendored for coding agents developing NCLI; it is not in the spawn prompt or `--add-dir` |
| `ncli/mcp.json` | the only MCP registry; injected per spawn, never into ~/.claude ~/.codex ~/.cursor |
| `src/mcp/` | Streamable HTTP `ncli` on `/mcp` (memory + bus + control). Token per spawn. No shim process |
| `src/bus/` | ncli-bus: unix socket + in-memory tickets. `ask`/`wait`/`post`/`inbox`/`read` |
| `public/` | chat UI, shortcuts rail, review modal |
| `src/perf/` | `bun run perf` traces. p50/p95 for start, paint, send, TTFT, SSE, fork, drawer, scroll, compact |

## Extension points (one line each)

- **View / mode** — a package in `views/<id>/` (`manifest.json` + `view.ts` + exclusive `skills/`). Loose `views/<id>.ts` is only for previews (`live`). Open with `view://id`. Share with `ncli view pack` / `ncli view add`.
- **Harness** — `AcpAdapter` in `src/acp/<id>.ts`, then a case in `pickHarness` + `HarnessKind`.
- **Render kind** — add to `LiveKind`, `frameHtml`, and the matching regex in `public/app.js`.
- **Memory** — env in `src/config.ts`. The turn uses the cover that is ready now. `pump()` builds nodes in the background. `settle()` waits for visible cover parts only. Off-cover parents need `settleQuiescent()`.
- **Shortcut** — spark inbox on the right rail (`src/live/inbox.ts`): trabalhando / precisa de você / pronto; settled drops off. `próximo` + Notification API when the tab is hidden.
- **Delegate** — `ask(agent, prompt)` on ncli-bus, or a `view://` spark. No extra daemons.
- **Queue** — `data/queue.json`. Send during a turn steers (mock, same turn) or waits for the next boundary. `fila` persists across restart. The memory tree does not see an item until it is delivered as `user`.
- **Bus** — one socket on the NCLI server. On-demand children. Posts land on the next turn (optional Claude hook is a single socket call).
- **MCP / skill** — add once in `ncli/mcp.json` / `ncli/skills/`. Spawn writes an HTTP `type: "http"` entry with a bearer token. The Bun server is already listening on `/mcp`.
- **Main harness** — same view + tools + ncli-bus. Quota walks `NCLI_FALLBACK` (default `NCLI_BACKUP` then claude/codex/cursor), stores `data/usage.json`, and emits an SSE chip. One `setTimeout` resumes the queue at the reset time parsed from the error. Snooze skips that auto-resume.
- **Worktree** — detached HEAD by default. `.worktreeinclude` copies extra files (gitignored env, etc). Close archives the worktree and branch unless the tree is dirty or has local commits; then it stays and `POST /api/sparks/:id/archive` with `{ force: true }` is required. Policy: `.ncli/worktree.json`.
- **Import** — `/ncli import claude|codex|cursor` is preview by default. `--apply` or `POST /api/import` appends `user`/`talk` into the project space for that `cwd`, or inbox when `cwd` is missing, then `pump()`. Claude project-folder slugs are not paths. Dedupe is `data/import-seen.json`. Roots: official session dirs, or `NCLI_IMPORT_*`. Read-only on those trees.
- **Review loop** — line comments batch through `POST /api/sparks/:id/act` → `ask`. Findings triage (aberto / resolvido / irrelevante) lives on the spark and as a `ncli ui` note. Re-review keeps the last `head`. A MERGED PR archives the worktree on open, act, or close — no poller.

Shipped views: `review` and `refino` (packages), `live` (loose preview). Scaffold: `bun run ncli new view foo` / `view pack` / `view add` / `remove`. Skills: `bun run ncli skills`.

## Spark packages

The main chat is the orchestrator. A `view://` line starts a spark — a running instance of a view. Each package declares its own agents, a deterministic flow (`spark` → … → `result`), exclusive skills, and a visualization. The hub gives the spark its own memory directory, optional worktree, skill `--add-dir`, and AGENTS.md. Main-session skills (`ncli-bus`, `add-view`, pstack) stay off that spawn.

When the flow reaches `result`, `ViewPlugin.result` builds `{ summary, artifacts, decisions, links }`. That object is stored on the spark and appended to the main log as one merge line. The main agent can start several sparks and keep using memory, compaction, bus, and live cards.

A package is shareable. `manifest.json` is schema-validated. Paths must be package-relative. `ncli view pack <id>` writes `<name>-<version>/` plus `PACK.json`. `ncli view add <path|git-url>` copies into `views/<name>/` and checks that a required harness exists on this host. Optional `mcp` is injected only on that spark's spawn. Authoring: `ncli/skills/add-view/SKILL.md`.
