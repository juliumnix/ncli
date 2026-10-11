---
name: add-mode
description: Add a view package with hold / needs_user / merge. Use when a spark must wait on the user or run in a worktree.
---

# Add a mode (view lifecycle)

A mode is a view package that owns a lifecycle. Same folder as a view; extra fields on `createSpark`.

## Files

- `views/<id>/` — package from `ncli new mode <id>` (`add-mode/template.ts` + add-view manifest)
- `src/views/types.ts` — `ViewCreateResult` (`hold`, `needsUser`, `needsWorktree`)
- `src/sparks/manager.ts` — already merges when `applyAction` returns `{ merge: true }`
- `src/types.ts` — `NeedsUserKind` is `"question" | "review"`

## Do

```bash
bun run ncli new mode <id>
```

Set:

- `needsWorktree: true` if the agent must edit a checkout
- `hold: true` to stay open after the boot turn
- `needsUser: { kind, label, count }` to show the right-rail avatar
- `applyAction` → `{ merge: true, summary }` when done; `{ needsUser: null }` to keep running

Glyph for the rail: `public/app.js` `renderShortcuts` (`glyph`). See `ncli/skills/add-shortcut`.

## Check

```bash
bun test tests/view-actions.test.ts tests/spark-merge.test.ts tests/self-hack.test.ts
```

Open `view://<id>`, confirm the avatar, act, see `<id> #1 voltou` in the main chat.
