---
name: ncli-bus
description: Ask Codex/Cursor/Claude through NCLI. Agents exist only while working. No watchers.
---

# ncli-bus

The NCLI server is the only long-lived process. `ask` spawns a CLI in the fork worktree, returns a ticket, the child exits. `wait` is an in-memory promise — zero polling. This is the only way to talk to another seat.

## Tools (MCP `ncli`, same stdio server as zoom)

- `ask(agent, prompt, {fork?, mode?, timeout?})` → ticket
- `wait(ticket|tickets, timeout)` → text

`timeout` is seconds when the number is below 1000 (so `120` is two minutes), or milliseconds when it is 1000 or more. Default ask is 120s. Default wait is 30s.
- `post(to, msg)` → short note to a seat, fork id, or `main`
- `inbox()` → drain pending posts (also prepended on the next turn)
- `read(query)` → search the bus ledger

`agent` is `claude` | `codex` | `cursor`.

## Wire

JSON lines on `data/ncli-bus.sock`: `{seq, from, to, kind: ask|reply|post|event, body, ticket}`. The MCP shim is a one-shot connect. Nothing runs in the background.

Mid-turn (Claude Code only), optional hook — one sub-10ms socket call, then exit:

```
bun run src/bus/hook.ts
```

PostToolUse / Stop. Not a daemon.

## Guards

`NCLI_BUS_DEPTH` (default 1, max useful 2), `NCLI_BUS_CHILDREN` (4), `NCLI_BUS_BUDGET` (8 asks per fork). Cycles on the ticket chain are rejected.

## UI

Each ask/reply/post is a ledger line, Telegram-style (`Codex → Claude: …`). Keep body short. Detail stays in the fork; `zoom` it.

## Check

```bash
bun test tests/bus.test.ts
```

Idle: `hub.bus.liveChildren() === 0` and no extra processes. After `wait`, the child is gone.
