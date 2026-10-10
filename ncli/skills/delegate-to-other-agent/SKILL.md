---
name: delegate-to-other-agent
description: Open a fork or ask another seat instead of doing the whole job in the main chat. Use when the user wants parallel work, a review, or Codex/Cursor.
---

# Delegate to another agent

Main chat stays Claude. Isolated work happens in forks. Extra seats show up as Telegram-style messages when you actually consult them.

## Do (fork)

Reply with a `view://` link. The hub opens it. Do not spawn a second NCLI.

```
view://review?pr=482
view://refino?card=Pickup+scheduling
view://live
```

Each fork has its own memory dir, harness turn, and optional git worktree. When it finishes, the main log gets one merge line (`<view> #<n> voltou`). `zoom` the fork id for the full log.

## Do (seat)

Use ncli-bus (ncli/skills/ncli-bus):

```
ask({ agent: "codex", prompt: "…" })
wait({ ticket })
```

Do not add watchers or extra daemons.

## Check

```bash
bun test tests/fork-merge.test.ts tests/concurrent-forks.test.ts tests/live.test.ts
```

Two forks can run at once. Main chat still has one assistant thread.
