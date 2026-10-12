---
name: ncli-ui
description: Reply with an interactive in-chat mini-app (tabs, charts, tables). Use when the user asks to show, compare, or visualize something in the thread.
---

# ncli-ui

The user asks in plain language ("mostra como card", "um gráfico disso", "documenta em abas", "mostra em 3D"). You reply with a self-contained mini-app or scene. Do not ask them to pick a fence.

## Contract

A fenced block in the reply, or MCP `ncli.render({kind:"ui", source})` and then repeat the returned fence:

````
```ncli ui
<div class="tabs">…</div>
```
````

`kind=ui` for cards. `kind=3d` for an in-chat three.js scene. Do not use `html` / `react` for these. The host injects NCLI dark tokens, `ncliChart`, `ncliUi.send`, and `ncli3d`. No CDN. No `fetch`. No cookies.

````
```ncli 3d
ncli3d.desk()
```
````

The fence source is the scene. `ncli3d.desk()` draws a wood top, metal frame, and clamp. `ncli3d.box()` draws a red cube. Scripts load from this hub (`/vendor/three.global.js`, `/ncli3d.js`) as classic scripts.

HTML, react, and 3d stay on `sandbox="allow-scripts"` without `allow-same-origin`. CSP is `default-src 'none'`. 3d scripts are `'self' blob:` (vendored three.js). Network is off. Images are `data:` only.

## When

Tabs for a short doc. Metric cards for a few numbers. A table with `.badge.ok|warn|bad` for status. `ncliChart(el, {type:"line"|"bar", labels, values})` for a series (hover tooltip, click to focus). `.gallery .ph` for mockup slots. `input type="range"` for a scrubber. Client-side only — tabs and sliders must not call the agent.

`ncliUi.send("texto")` only when you put an explicit action in the card ("pedir o plano B"). That text lands as a normal user message.

## Markup the host already styles

`.tabs button.on`, `.metrics .metric`, `table`, `.badge`, `.gallery .ph`, `.hint` / `.muted`, `input[type=range]`. Tokens: `--bg --card --line --fg --muted --accent`.

Keep the source small. Put scripts after the markup so `ncliChart` exists. Do not stream raw HTML as markdown.

## Check

```bash
bun test tests/ncli-ui.test.ts tests/live.test.ts tests/live-3d.test.ts
```
