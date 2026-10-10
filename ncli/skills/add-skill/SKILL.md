---
name: add-skill
description: Add a skill once under ncli/skills. Every harness reads that tree on spawn. Use when the user wants a new NCLI skill.
---

# Add a skill

One tree: `ncli/skills/<id>/SKILL.md`. Installing a skill means adding it there. NCLI injects the runtime index (not the vendored pstack tree) into Claude / Codex / Cursor on spawn. Do not put skills in `~/.claude`, `~/.codex`, or `~/.cursor`.

## Do

1. Create `ncli/skills/<id>/SKILL.md` (frontmatter `name` + `description`, then short steps, exact paths, a check command).
2. Optional template next to it (`template.ts`) if scaffold needs one.
3. If it is a pstack upstream skill, put it in `ncli/skills/pstack/` via `bun run scripts/sync-pstack.ts`, not by hand.
4. If it is an Emil design skill, put it in `ncli/skills/emil/` via `bun run scripts/sync-emil.ts`, not by hand.

Id: `[a-z][a-z0-9-]*`. Keep the body short. The catalog picks up any folder with `SKILL.md` except the vendored `pstack/` tree (development only) and `emil/` (listed for UI work).

## Check

```bash
bun run ncli skills
bun test tests/self-hack.test.ts tests/mcp-inject.test.ts
```
