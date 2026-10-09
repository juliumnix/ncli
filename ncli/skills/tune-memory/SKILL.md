---
name: tune-memory
description: Change OptChat view/node size or compaction budget. Use when the drawer is too coarse, too expensive, or summaries skip facts.
---

# Tune memory / compaction

## Files

- `src/config.ts` — `NCLI_VIEW`, `NCLI_NODE`, `NCLI_COMPACT_*`
- `src/memory/store.ts` — tree + `pump()` (do not block the user turn)
- `src/memory/cursor-compact.ts` — batch, hash cache, skip, daily budget
- `src/memory/sdk-compact.ts` — `@cursor/sdk` only (not `cursor-agent acp`)
- `~/.config/ncli/secrets.env` — `NCLI_CURSOR_API_KEY` (chmod 600)
- `data/compact-log.jsonl` — token spend (gitignored)

## Env (defaults)

| Var | Default | Meaning |
| --- | --- | --- |
| `NCLI_VIEW` | 2500 | cover budget in bytes |
| `NCLI_NODE` | 280 | summary line target |
| `NCLI_COMPACT` | auto | `cursor` / `claude` / `mock` |
| `NCLI_COMPACT_BATCH` | 6 | nodes per Cursor SDK call |
| `NCLI_COMPACT_SKIP` | 80 | skip the SDK at or under this many tokens |
| `NCLI_CURSOR_API_KEY` | file | compaction SDK only; `~/.config/ncli/secrets.env` |
| `NCLI_COMPACT_BUDGET` | 250000 | daily compaction tokens |

Restart after env changes. Do not compact inside `Hub.turn`; keep `void memory.pump()`.

## Check

```bash
bun test tests/compaction.test.ts tests/compact-cursor.test.ts tests/hop.test.ts tests/context.test.ts
```

Drawer ☰ shows `bytes/budget`. Cover must stay ≤ `NCLI_VIEW`.
