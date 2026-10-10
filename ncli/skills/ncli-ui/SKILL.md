---
name: ncli-ui
description: Reply with an interactive in-chat mini-app (tabs, charts, tables). Use when the user asks to show, compare, or visualize something in the thread.
---

# ncli-ui

The user asks in plain language ("mostra como card", "um gráfico disso", "documenta em abas"). You reply with a self-contained mini-app. Do not ask them to pick a fence.

## Contract

A fenced block in the reply, or MCP `ncli.render({kind:"ui", source})` and then repeat the returned fence:

````
```ncli ui
<div class="tabs">…</div>
```
````

`kind=ui` only. Do not use `html` / `react` for these cards. The host injects NCLI dark tokens, `ncliChart`, and `ncliUi.send`. No CDN. No `fetch`. No cookies.

The iframe is sandboxed (`allow-scripts`, no `allow-same-origin`) with `default-src 'none'`. Network is off. Images are `data:` only.

## When

Tabs for a short doc. Metric cards for a few numbers. A table with `.badge.ok|warn|bad` for status. `ncliChart(el, {type:"line"|"bar", labels, values})` for a series (hover tooltip, click to focus). `.gallery .ph` for mockup slots. `input type="range"` for a scrubber. Client-side only — tabs and sliders must not call the agent.

`ncliUi.send("texto")` only when you put an explicit action in the card ("pedir o plano B"). That text lands as a normal user message.

## Markup the host already styles

`.tabs button.on`, `.metrics .metric`, `table`, `.badge`, `.gallery .ph`, `.hint` / `.muted`, `input[type=range]`. Tokens: `--bg --card --line --fg --muted --accent`.

Keep the source small. Put scripts after the markup so `ncliChart` exists. Do not stream raw HTML as markdown.

## Check

```bash
bun test tests/ncli-ui.test.ts tests/live.test.ts
```
