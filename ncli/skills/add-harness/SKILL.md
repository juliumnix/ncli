---
name: add-harness
description: Wrap a CLI as an ACP-shaped adapter. Use when the user wants NCLI to drive another coding-agent binary.
---

# Add a harness adapter

ACP here is NCLI's in-process contract (`src/acp/types.ts`). Do not add an Agent SDK, Zed `claude-code-acp`, harukitosa, or `@anthropic-ai/claude-agent-sdk`.

## Files

- `src/acp/<id>.ts` — `AcpAdapter` (`run` → `AcpUpdate` stream)
- `src/acp/types.ts` — `AcpAdapter` / `AcpUpdate`
- `src/harness/acp.ts` — already maps updates → harness events
- `src/harness/child-env.ts` — strip `ANTHROPIC_API_KEY` and OAuth
- `src/config.ts` — add to `HarnessKind` + env (`NCLI_<ID>`)
- `src/hub.ts` — `pickHarness` case
- `tests/acp.test.ts` — parse fixtures, never spawn the real binary

## Do

```bash
bun run ncli new harness <id>
```

Then wire `HarnessKind` + `pickHarness`. Spawn the unmodified vendor CLI. Prefer wrapping stdout JSON like `claude -p --output-format stream-json` or `codex exec --json`. Cursor stays first-party `cursor-agent acp`.

## Check

```bash
bun test tests/acp.test.ts
rg -n "claude-agent-sdk|claude-code-acp|cursor-agent-acp|codex-acp" package.json src
```
