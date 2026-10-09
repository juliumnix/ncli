# NCLI usability tasks

Work one item at a time. Finish, test, commit, then move on.

1. [x] ncli MCP connect + single-process `bun start`
   Streamable HTTP MCP on the Bun server, token per spawn, listening before any child. Startup summary. Fail loud. Readiness test.
2. [x] Live streaming timeline
   Status line + timer, thinking, live tool rows, token stream, nested asks, still-working after 5s, stop, persist timeline. Non-blocking POST /api/message. SSE idleTimeout.
3. [x] Author + header agent
   Avatar, name, model on every message (main and forks). Header shows main agent and switches live. Quota fallback updates the indicator and posts a notice.
4. [ ] Markdown
   Render agent messages as sanitized Markdown while streaming. No raw `**`.
5. [ ] Shimmer for live content
   Skeleton while an `ncli` block streams. Crossfade to the preview. Error + raw source on failure. prefers-reduced-motion.
6. [ ] Fork pill animation
   Slide-in + fade/scale on create. Attention pulse when the fork needs input or finishes. prefers-reduced-motion.
7. [ ] Compaction
   UI indicator (running, nodes, tokens vs budget). Model in startup summary. `bun run compact:check`. Batch cap under 100k input tokens (default ~60k).
8. [ ] Favicon + root `bun test`
   Serve `/favicon.ico`. Root `bun test` only runs NCLI tests.

After all eight: README + ARCHITECTURE, screenshots, PR.
