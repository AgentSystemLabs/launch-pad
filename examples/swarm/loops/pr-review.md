# Loop: pr-review

1. `gh pr list --state open --json number,title,reviewDecision,author` — pick oldest **unreviewed** PR.
2. Check out PR branch; read diff only (no drive-by refactors).
3. Leave review: **approve** or **request changes** with file:line notes. Swarm merges without humans.
4. MCP `wal_append` `{ "event": "working", "summary": "Reviewing PR #N" }` then `done` with report.
5. If no open PRs, file an `idea` issue or run `create-pr.md`.

## Close out (required)

- Heartbeat with MCP `agent_status` when you start and whenever your focus shifts.
- Stream notable progress lines with MCP `stdout_append` (key steps, not every token) so the operator can watch live.
- Finish with MCP `wal_append` `{ "event": "done", "loop": "<this-loop>", "summary": "<short title>", "report": "<one paragraph: what you did, PR/issue links, checks run>" }`.
- Release every lock you hold. Never wait for human review — self-review and proceed autonomously; stop only when the operator pauses the swarm.
