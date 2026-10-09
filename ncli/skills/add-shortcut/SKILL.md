---
name: add-shortcut
description: Put a fork on the right-rail avatar when it needs the user. Use when a mode should wait, badge, or get a new glyph.
---

# Add a shortcut / needs-user state

The rail is not a launcher. Only `status === "needs_user"` forks appear.

## Files

- `src/types.ts` — `NeedsUser` / `NeedsUserKind` (`"question" | "review"`)
- `views/<id>.ts` — `createFork` returns `needsUser`; `applyAction` clears with `needsUser: null`
- `src/forks/manager.ts` — `waitingOnUser()`
- `public/app.js` — `renderShortcuts` (`glyph` map, badge, label)

## Do

1. Extend `NeedsUserKind` only if question/review is the wrong meaning. Keep the `never` checks if you switch on it.
2. Set `needsUser: { kind, label, count }` and `hold: true`.
3. Add `glyph.<id>` in `renderShortcuts`. Fallback is `●`.
4. When the user answers, `applyAction` returns `{ needsUser: null }` or `{ merge: true }`.

## Check

```bash
bun test tests/view-actions.test.ts tests/live.test.ts
```

Avatar shows with badge. After the act, it leaves the rail. Running forks stay off it.
