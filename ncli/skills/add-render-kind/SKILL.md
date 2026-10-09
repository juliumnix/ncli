---
name: add-render-kind
description: Add a ```ncli <kind> fence and ncli.render kind. Use when the user wants a new live preview type.
---

# Add a render kind

## Files

- `src/live/parse.ts` — `LiveKind` union + `FENCE` regex + `renderToolToFence` guard
- `src/live/frame.ts` — `frameHtml` switch (keep the `never` default)
- `public/app.js` — the same kind list in `bodyHtml` / `iframeFor` (client renders chat fences)
- `src/mcp/memory-zoom.ts` — `ncli.render` description
- `views/live.ts` — optional demo block

No CDN. HTML/react stay on `sandbox="allow-scripts"` without `allow-same-origin`. `url` only `http:`/`https:`.

## Do

Add the kind to the union, then the `frameHtml` case, then the client regex. `bun run ncli new render <kind>` prints this skill; it does not patch four files.

## Check

```bash
bun test tests/live.test.ts
```

A fenced block in chat and `view://live` must both show the new kind. `javascript:` URLs stay blocked.
