---
name: ncli-ui
description: Reply with an interactive in-chat mini-app or a 3D architecture scene. Use when the user asks to show, compare, visualize, or draw a flow in the thread.
---

# ncli-ui

Claude, Codex, and Cursor use the same fences. Do not ask the user to pick one. Do not invent a fourth kind. Do not nest a fence inside another fence.

## Exact fences (copy the fences, never the sample bodies)

Diagram (flowchart, mermaid, boxes and arrows):

````
```ncli mermaid
flowchart TD
  <id>[<label from the user's topic>] --> <id2>[<label from the user's topic>]
```
````

Card (tabs, metrics, table, chart):

````
```ncli ui
<div class="tabs">…markup for this request…</div>
```
````

3D architecture or flow (nodes, arrows, layers — not furniture):

````
```ncli 3d
ncli3d.graph({
  nodes: [{id:"a",label:"<name from the request>"},{id:"b",label:"<name from the request>"}],
  edges: [["a","b"]],
  layers: [["a"],["b"]]
})
```
````

The bodies above are format templates. Every `label` / tab / metric must come from the user's topic. If you paste a sample body unchanged, you failed the skill.

`kind=ui` only for cards. `kind=mermaid` only for diagrams. `kind=3d` only for `ncli3d.graph`. Do not use `html` / `react` / ` ```mermaid ` / ` ```ncli ui ` wrapping mermaid.

## Host rules

The host injects NCLI dark tokens, `ncliChart`, `ncliUi.send`, and `ncli3d`. No CDN. No `fetch`. No cookies. The iframe is sandboxed (`allow-scripts`, no `allow-same-origin`) with `default-src 'none'`. Images are `data:` only.

`ncli3d.graph({nodes, edges, layers})` draws labeled blocks, arrows, and layers. Labels are the real names from the request (services, seats, files). Do not call the furniture helpers unless the user asked for a desk or a cube.

## When

Tabs for a short doc. Metric cards for a few numbers. A table with `.badge.ok|warn|bad`. `ncliChart(el, {type:"line"|"bar", labels, values})` for a series. `.gallery .ph` is an empty slot — do not use it as the whole card. Client-side only.

`ncliUi.send("texto")` only for an explicit action on the card.

## Markup the host already styles

`.tabs button.on`, `.metrics .metric`, `table`, `.badge`, `.gallery .ph`, `.hint` / `.muted`, `input[type=range]`. Tokens: `--bg --card --line --fg --muted --accent`.

Keep the source small. Put scripts after the markup so `ncliChart` exists. Do not stream raw HTML as markdown.

## Check

```bash
bun test tests/ncli-ui.test.ts tests/live.test.ts tests/live-3d.test.ts tests/ncli-ui-card.test.ts
```
