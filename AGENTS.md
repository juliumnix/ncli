# NCLI development uses pstack

pstack is for **developing** this repo in Cursor. It is not used at runtime. The NCLI chat is a normal chat: Claude, Codex, and Cursor talk through NCLI's own bus (`ask` / `wait`). Runtime spawns get only NCLI skills (`ncli-bus`, views, …) and Emil when the work is UI. The vendored copy lives at `ncli/skills/pstack/` so every coding agent working on NCLI sees the same playbooks. Do not inject those files into harness `AGENTS.md`, `--add-dir`, or the assembled system prompt.

The agent **inside** NCLI hacks NCLI from `ncli/skills/*/SKILL.md` (runtime skills only on spawn). MCP servers live in `ncli/mcp.json`. Map: `docs/ARCHITECTURE.md`. Scaffold: `bun run ncli new view <id>` / `bun run ncli remove view <id>` or `/ncli` in chat.

## How to start

1. Install the Cursor plugin: `/add-plugin pstack`.
2. Run `/setup-pstack` once per machine.
3. For any non-trivial task, start with `/poteto-mode`.

If the plugin is missing, clone `https://github.com/cursor/plugins` and follow `pstack/skills/poteto-mode/SKILL.md` plus the matching playbook under `pstack/skills/poteto-mode/playbooks/`.

## Playbooks this repo expects

- New behavior: Feature (`playbooks/feature.md`). Name the data shape first.
- A defect with a cheap test: `/tdd` (failing test, then fix).
- Code that crosses a module boundary: `/architect` before writing logic.
- A small-looking change you do not trust: `/blast-radius`, and prove the safety fact by running code.
- Before commit: deslop (cursor-team-kit `/deslop`) and `/no-comments`.
- Docs, README, commit messages: `/technical-writing`.
- Adversarial review of a contested design: `/interrogate`.

## Claude, Cursor, Codex

ACP is NCLI's internal session contract (`src/acp/types.ts`). Do not add `@anthropic-ai/claude-agent-sdk`, `@agentclientprotocol/sdk`, Zed `claude-code-acp`, harukitosa, `npx cursor-agent-acp`, or `@agentclientprotocol/codex-acp`.

- Claude: spawn the unmodified `claude` binary with `-p --output-format stream-json --verbose` and the official flags (`--resume` / `--session-id`, `--system-prompt-file`, `--mcp-config`, `--model`). That is the primary path, not a fallback.
- Cursor: first-party `cursor-agent acp` / `agent acp` only ([docs](https://cursor.com/docs/cli/acp)). Compaction uses `cursor-agent --print`.
- Codex: wrap `codex exec --json` unless OpenAI ships a native ACP entrypoint on the `codex` binary itself.
- Never read, write, or forward OAuth tokens. Strip `ANTHROPIC_API_KEY` from child env unless `NCLI_CLAUDE_API_KEY=1`.

## Principles that constrain NCLI

Read the leaf skill before applying it.

- Subtract before you add. Delete dead views, mock paths, and unused adapters before growing the tree.
- Separate before serializing shared state. Each fork owns its memory directory, harness process, and git worktree. The main log is the only merge point.
- Model the domain. Chat is an append-only log plus a binary summary tree. Forks are isolated runtimes, not flags on the main session.
- Test behavior, not implementation. Assert recovered facts, merge text, worktree paths, and registry ids. Do not assert mock call counts.
- Prove it works. `bun test` plus a running `bun start` page, not "it typechecks".

## Changing NCLI itself

Follow the matching skill, do not improvise a second registry.

| Ask | Skill |
| --- | --- |
| new / edit / delete a `view://` surface | `ncli/skills/add-view`, `edit-view`, `remove-view` |
| fork type (hold, needs_user, worktree) | `ncli/skills/add-mode` |
| new ` ```ncli ` kind | `ncli/skills/add-render-kind` |
| wrap another CLI | `ncli/skills/add-harness` |
| view budget / compaction | `ncli/skills/tune-memory` |
| right-rail avatar | `ncli/skills/add-shortcut` |
| parallel work / other seat | `ncli/skills/delegate-to-other-agent` |
| ask Codex/Cursor | `ncli/skills/ncli-bus` |
| add a skill / MCP once | `ncli/skills/add-skill`, `add-mcp` |
| stuck turn | `ncli/skills/debug-ncli` |

One file in `views/`, default export, hot-reloaded. No registry edit.
