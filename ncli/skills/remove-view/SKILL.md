---
name: remove-view
description: Delete a view package (or loose .ts) so it disappears from the live registry.
---

# Remove a view

## Files

- `views/<id>/` — delete the package (manifest, view.ts, skills)
- or `views/<id>.ts` — loose preview such as `live`
- tests that expect the id — update them

Do not leave a stub. Do not edit the registry.

## Do

```bash
bun run ncli remove view <id>
```

Shipped views (`review`, `refino`, `live`) need `--force` and an explicit user ask.

## Check

```bash
bun test tests/views.test.ts tests/self-hack.test.ts
```

Drawer ☰ must not list it. `view://<id>` from chat should error `view desconhecida`.
