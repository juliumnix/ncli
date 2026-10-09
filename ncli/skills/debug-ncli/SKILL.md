---
name: debug-ncli
description: Find why a turn, fork, or view failed. Use when the user says NCLI is stuck, empty, or wrong.
---

# Debug NCLI

There is no separate ledger. The source of truth is the append-only chat log plus fork meta.

## Files / paths

- `data/last-view.txt` — last assembled cover sent to the harness
- `data/main/log.jsonl` + `data/main/tree.jsonl` — main memory
- `data/forks/<id>/meta.json` + `log.jsonl` — fork state and log
- `data/compact-log.jsonl` — compaction tokens
- `data/ncli-bus.sock` — unix socket of the in-process bus (no extra daemon)
- drawer ☰ — live cover, byte budget, `view://` list
- `src/server.ts` — `/api/state`, `/api/events`

## Do

1. Read `/api/state` or the drawer. Check `forks[].status` and `needsUser`.
2. `rg` the skill for the surface (`add-view`, `add-harness`, …).
3. Run the listed check command, not the whole world first.

```bash
bun test
bun run ncli skills
```

Mock harness: `NCLI_HARNESS=mock bun start`. Real Claude: `NCLI_HARNESS=claude bun start`. Never pass OAuth through.

## Check

Repro with `bun test tests/<area>.test.ts`. If hot reload missed a delete, confirm `views/<id>.ts` is gone and the drawer dropped it.
