---
name: edit-view
description: Change an existing view in place. Use when the user wants different tabs, UI, merge rules, or params on review/refino/live or a custom view.
---

# Edit a view

## Files

- `views/<id>.ts` — edit this file; registry reloads on save
- `src/review/model.ts` — only if the view is `review` (diff/plan/chapters)
- `public/app.css` — only if you need new classes (prefix them, e.g. `rv-`)
- `public/app.js` — only if the modal needs new `data-*` clicks (`data-act`, `data-rv-*`)

## Do

1. Read `views/<id>.ts` and `src/views/types.ts`.
2. Change `createFork` / `render` / `applyAction`. Keep `id` stable.
3. Save. Do not restart. Do not edit `src/views/registry.ts`.

If the fork type itself must change (hold, needsUser, worktree), follow `ncli/skills/add-mode/SKILL.md`.

## Check

```bash
bun test tests/views.test.ts tests/view-actions.test.ts tests/review-guide.test.ts
```

Re-open the fork from the right rail. Existing `data/forks/<id>-N/meta.json` keeps the old `ui` until you open a new fork.
