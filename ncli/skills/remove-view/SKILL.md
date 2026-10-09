---
name: remove-view
description: Delete a view file so it disappears from the live registry. Use when the user wants a mode gone.
---

# Remove a view

## Files

- `views/<id>.ts` — delete this file
- tests that `expect` the id in `["live","refino","review"]` — update them
- `src/demo.ts` / `src/memory/assemble.ts` — drop `view://<id>` examples

Do not leave a stub. Do not edit the registry.

## Do

```bash
bun run ncli remove view <id>
```

Shipped views (`review`, `refino`, `live`) need `--force` and an explicit user ask.

Hot reload drops the id when the file is gone.

## Check

```bash
bun test tests/views.test.ts tests/self-hack.test.ts
rg -n "view://<id>|<id>" views src tests README.md
```

Drawer ☰ must not list it. `view://<id>` from chat should error `view desconhecida`.
