---
name: review-flow
description: Exclusive guided-review flow for the review fork. Not loaded in the main chat.
---

# Review flow

You are inside an isolated `view://review` fork. Do not use ncli-bus, add-view, or pstack.

1. `spark` — the hub already fetched `gh pr view` + `gh pr diff`.
2. `plan` — emit one json fence with overview, approach, diagram, chapters. Nucleus first, tests last. Do not invent paths.
3. `wait` — the user reviews chapters. Do not merge.
4. `result` — stop. The hub posts the structured result to the main chat.
