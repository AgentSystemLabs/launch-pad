# Loop: ux-review

1. `npm ci && npm run build` (skip if already done this session).
2. Run `node scripts/browser-test.mjs` or describe a manual UX walkthrough of join → walk → chat → voice UI.
3. File **one** UX issue per friction point OR open a micro-PR (copy, spacing, focus order, mobile joystick).
4. Labels: `swarm`, `ux`.
5. Attach screenshots or console notes in the issue comment.

## Close out (required)

- Heartbeat with MCP `agent_status` when you start and whenever your focus shifts.
- Stream notable progress lines with MCP `stdout_append` (key steps, not every token) so the operator can watch live.
- Finish with MCP `wal_append` `{ "event": "done", "loop": "<this-loop>", "summary": "<short title>", "report": "<one paragraph: what you did, PR/issue links, checks run>" }`.
- Release every lock you hold. Never wait for human review — self-review and proceed autonomously; stop only when the operator pauses the swarm.
