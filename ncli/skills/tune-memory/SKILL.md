---
name: tune-memory
description: Change OptChat view/node size or compaction budget. Use when the drawer is too coarse, too expensive, or summaries skip facts.
---

# Tune memory / compaction

## Files

- `src/config.ts` — `NCLI_VIEW`, `NCLI_NODE`, `NCLI_COMPACT_*`
- `src/memory/store.ts` — tree + `pump()` in the background. `settle()` waits for the visible cover only. `settleQuiescent()` waits until the tree is idle
- `src/memory/cursor-compact.ts` — batch, hash cache, skip, daily budget
- `src/memory/sdk-compact.ts` — `@cursor/sdk` only (not `cursor-agent acp`)
- `~/.config/ncli/secrets.env` — `NCLI_CURSOR_API_KEY` (chmod 600)
- `data/compact-log.jsonl` — token spend (gitignored)

## Env (defaults)

| Var | Default | Meaning |
| --- | --- | --- |
| `NCLI_VIEW` | 2500 | cover merge-back target in bytes. Drawer shows `2 ×` this |
| `NCLI_NODE` | 280 | summary line target |
| `NCLI_COMPACT` | auto | `cursor` / `claude` / `mock` |
| `NCLI_COMPACT_BATCH` | 6 | nodes per Cursor SDK call |
| `NCLI_COMPACT_SKIP` | 80 | skip the SDK at or under this many tokens and cut locally |
| `NCLI_CURSOR_API_KEY` | file | compaction SDK only; `~/.config/ncli/secrets.env` |
| `NCLI_COMPACT_BUDGET` | 250000 | daily compaction tokens |
| `NCLI_COMPACT_SETTLE` | 0 | unused on the turn path. The turn never waits for compaction |
| `NCLI_COMPACT_TIMEOUT` | 30000 | compressor call timeout. `0` disables it. A stuck call becomes `CompactDeferred` so it does not hold a pump slot |

Restart after env changes. `Hub.turn` starts `pump()` and assembles the cover that is ready now. Compaction still runs in `pump()`, not inside the model call. The debounce is not flushed at turn start, so siblings can share one Cursor call. The cover cannot stay above `2 × NCLI_VIEW`.

## Check

```bash
bun test tests/compaction.test.ts tests/compact-cursor.test.ts tests/hop.test.ts tests/context.test.ts
```

Drawer ☰ shows `bytes/budget`. The cover is a sawtooth: it grows to `2 × NCLI_VIEW` and merges back to `NCLI_VIEW`.
