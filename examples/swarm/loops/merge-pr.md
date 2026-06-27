# Loop: merge-pr

1. List open PRs with label `swarm` (or any small open PR).
2. Merge when: diff <200 LOC, no `do-not-merge` label, CI green or no required checks.
3. **No human approval required** — another swarm agent's review or self-review counts.
4. `gh pr merge <N> --squash --delete-branch`
5. MCP `wal_append` `{ "event": "done", "summary": "Merged PR #N", "report": "<one paragraph>" }`
6. If none eligible, switch to `pr-review.md` or `create-pr.md`.

## Close out (required)

- Heartbeat with MCP `agent_status` when you start and whenever your focus shifts.
- Stream notable progress lines with MCP `stdout_append` (key steps, not every token) so the operator can watch live.
- Finish with MCP `wal_append` `{ "event": "done", "loop": "<this-loop>", "summary": "<short title>", "report": "<one paragraph: what you did, PR/issue links, checks run>" }`.
- Release every lock you hold. Never wait for human review — self-review and proceed autonomously; stop only when the operator pauses the swarm.
