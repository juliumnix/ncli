---
name: add-view
description: Add a shareable view:// fork package (manifest, agents, exclusive skills, flow, UI). Use when the user wants a new isolated fork type.
---

# Add a fork package

A fork type is a self-contained package. Anyone who installs it must get the same agents, exclusive skills, flow, and UI. No author home paths. No global `~/.cursor` / `~/.claude` / `~/.codex`.

```
views/<id>/
  manifest.json    # name, semver, requires.harnesses[+models], agents, skills, flow, optional mcp
  view.ts          # default export ViewPlugin + render / result
  skills/<id>-flow/SKILL.md
  mcp.json         # optional; extra MCP servers, fork spawn only
```

`live` stays a loose `views/live.ts` preview. Review and refino are packages. Dropping the folder into `views/<id>/` is enough for hot-reload.

## Author

```bash
bun run ncli new view <id>
```

Id: `[a-z][a-z0-9]*`. Scaffold writes the folder from `ncli/skills/add-view/template.*`. Do not register it by hand.

`manifest.json` is schema-validated at load, pack, and add:

- `requires.harnesses` — at least one of `claude | codex | cursor | mock | auto`
- `requires.models` — optional pin per harness; ids only, never `~/` or `$HOME`
- `agents` — each harness must be in `requires.harnesses`
- `flow` — first step `spark`, some step `result`, `next` ids must exist
- `skills` / `mcp` — package-relative. `..`, `~/`, `$ENV`, `.cursor` are rejected

Open with `view://<id>?key=value`. The hub sparks the fork (own memory, own worktree if `needsWorktree`, own skills, own optional MCP). When the flow hits `result`, `{ summary, artifacts, decisions, links }` lands on the main memory tree.

## Share

```bash
bun run ncli view pack <id> [out-dir]
```

Writes `<name>-<version>/` plus `PACK.json` (name, version, requires, agents). That folder is the unit you zip or push.

## Install

```bash
bun run ncli view add ./echo-1.0.0
bun run ncli view add https://github.com/you/ncli-view-echo.git
bun run ncli view add https://github.com/you/ncli-view-echo.git#v1.2.0
```

`add` clones a git URL (optional `#ref`) or copies a directory, finds `manifest.json` (root or a single `views/<id>/`), validates, and copies into `views/<name>/`. Install and open fail with a clear error if none of `requires.harnesses` exist on this host (`view echo@1.0.0 exige cursor; neste host: mock`).

Or drop the folder into `views/<name>/` yourself. Same schema check on the next load.

## Check

```bash
bun test tests/views.test.ts tests/view-pack.test.ts tests/self-hack.test.ts
```

Leave `bun start` running. Drawer ☰ lists `view://<id>`. Main-session spawn must not `--add-dir` `views/<id>/skills` and must not load the package `mcp.json`.
