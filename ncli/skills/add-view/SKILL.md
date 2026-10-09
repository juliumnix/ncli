---
name: add-view
description: Add a view:// surface. One file in views/, hot-reloaded. Use when the user wants a new NCLI panel or fork.
---

# Add a view

## Files

- `views/<id>.ts` — the only file you create (default export, `ViewPlugin`)
- `src/views/types.ts` — contract (`id`, `createFork`, optional `render` / `applyAction`)
- `src/views/registry.ts` — already watches `views/`; do not register by hand

## Do

```bash
bun run ncli new view <id>
```

Or write `views/<id>.ts` from `ncli/skills/add-view/template.ts` (`{{id}}` → the id). Id: `[a-z][a-z0-9]*`.

Open it with `view://<id>?key=value` in the main chat, or `POST /api/forks` `{ "view": "<id>", "params": {} }`.

## Check

```bash
bun test tests/views.test.ts tests/self-hack.test.ts
```

Leave `bun start` running. Drawer ☰ lists `view://<id>` without a restart.
