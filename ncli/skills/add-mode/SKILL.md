---
name: add-mode
description: Add a fork type with hold / needs_user / merge. Use when a view must wait on the user or run in a worktree.
---

# Add a mode (fork type)

A mode is a view that owns a fork lifecycle. Same file as a view; extra fields on `createFork`.

## Files

- `views/<id>.ts` — from `ncli/skills/add-mode/template.ts`
- `src/views/types.ts` — `ViewCreateResult` (`hold`, `needsUser`, `needsWorktree`)
- `src/forks/manager.ts` — already merges when `applyAction` returns `{ merge: true }`
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
bun test tests/view-actions.test.ts tests/fork-merge.test.ts tests/self-hack.test.ts
```

Open `view://<id>`, confirm the avatar, act, see `<id> #1 voltou` in the main chat.
