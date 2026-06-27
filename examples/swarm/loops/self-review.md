# Loop: self-review

1. Find your open PR (label `swarm` or branch prefix `swarm/`).
2. Re-read diff; fix nits yourself if <15 LOC.
3. Approve your own PR via `gh pr review --approve` when checks pass — **no human needed**.
4. MCP `done` report describing what you verified.

## Close out (required)

- Heartbeat with MCP `agent_status` when you start and whenever your focus shifts.
- Stream notable progress lines with MCP `stdout_append` (key steps, not every token) so the operator can watch live.
- Finish with MCP `wal_append` `{ "event": "done", "loop": "<this-loop>", "summary": "<short title>", "report": "<one paragraph: what you did, PR/issue links, checks run>" }`.
- Release every lock you hold. Never wait for human review — self-review and proceed autonomously; stop only when the operator pauses the swarm.
