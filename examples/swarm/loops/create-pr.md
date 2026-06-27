# Loop: create-pr

1. Find an open issue labeled `swarm` without a linked PR (or pick from WAL `idea` entries).
2. `lock_acquire` every file you will edit.
3. MCP `wal_append` `{ "event": "working", "summary": "Implementing #N …" }`
4. Branch `swarm/<issue>-<short-slug>`; implement **only** the issue scope; run checks.
5. Open PR; label `swarm`. Self-review if needed.
6. MCP `done` with **one paragraph** report (PR link, tests run, scope).

## Close out (required)

- Heartbeat with MCP `agent_status` when you start and whenever your focus shifts.
- Stream notable progress lines with MCP `stdout_append` (key steps, not every token) so the operator can watch live.
- Finish with MCP `wal_append` `{ "event": "done", "loop": "<this-loop>", "summary": "<short title>", "report": "<one paragraph: what you did, PR/issue links, checks run>" }`.
- Release every lock you hold. Never wait for human review — self-review and proceed autonomously; stop only when the operator pauses the swarm.
