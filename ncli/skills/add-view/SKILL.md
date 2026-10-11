---
name: add-view
description: Add a shareable view:// fork package (manifest, agents, exclusive skills, flow, UI). Use when the user wants a new isolated fork type.
---

# Add a fork package

A fork type is a self-contained package, not a single file.

```
views/<id>/
  manifest.json    # name, version, requires.harnesses, agents, skills, flow
  view.ts          # default export ViewPlugin + render / result
  skills/<id>-flow/SKILL.md   # exclusive; never injected into main
```

`live` stays a loose `views/live.ts` preview. Review and refino are packages.

## Do

```bash
bun run ncli new view <id>
```

Id: `[a-z][a-z0-9]*`. The scaffold writes the folder from `ncli/skills/add-view/template.*`. Do not register it by hand. Do not put `~/`, `$HOME`, or `.cursor` paths in the manifest.

Open with `view://<id>?key=value` in the main chat. The hub sparks the fork (own memory, own worktree if `needsWorktree`, own skills, own MCP add-dir). When the flow hits `result`, a structured `{ summary, artifacts, decisions, links }` lands on the main memory tree as a merge line.

## Share / install

The package must run on someone else's machine with the declared harnesses. No author home paths.

```bash
bun run ncli view pack <id> [out-dir]
bun run ncli view add <path-or-unpacked-pack>
```

`add` copies into `views/<name>/` and validates the schema. `pack` writes `<name>-<version>/` plus `PACK.json`.

## Check

```bash
bun test tests/views.test.ts tests/view-pack.test.ts tests/self-hack.test.ts
```

Leave `bun start` running. Drawer ☰ lists `view://<id>`. Main-session spawn must not `--add-dir` `views/<id>/skills`.
