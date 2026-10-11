---
name: edit-view
description: Change an existing view package in place (manifest, flow, exclusive skills, UI).
---

# Edit a view

## Files

- `views/<id>/view.ts` — plugin; registry reloads on save
- `views/<id>/manifest.json` — agents, flow, requires
- `views/<id>/skills/` — exclusive skills
- `src/review/model.ts` — only if the view is `review`
- `public/app.css` / `public/app.js` — only for new `data-*` clicks

Loose previews still live at `views/<id>.ts` (`live`).

## Do

1. Read the package and `src/views/types.ts` / `src/views/manifest.ts`.
2. Keep `manifest.name` = `plugin.id`. Keep flow spark-first and result-last.
3. Save. Do not restart. Do not edit `src/views/registry.ts`.

## Check

```bash
bun test tests/views.test.ts tests/view-pack.test.ts tests/view-actions.test.ts tests/review-guide.test.ts
```
