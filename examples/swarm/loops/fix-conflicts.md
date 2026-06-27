# Loop: fix-conflicts

1. `gh pr list --label swarm --json number,mergeable,mergeStateStatus` — pick PR with `CONFLICTING` or `BEHIND`.
2. Check out branch; `git fetch origin && git rebase origin/main` (or merge main if project prefers).
3. Resolve conflicts **minimally**; run syntax check.
4. Force-push only the PR branch; comment what you resolved.
5. Release locks when done.

## Close out (required)

- Heartbeat with MCP `agent_status` when you start and whenever your focus shifts.
- Stream notable progress lines with MCP `stdout_append` (key steps, not every token) so the operator can watch live.
- Finish with MCP `wal_append` `{ "event": "done", "loop": "<this-loop>", "summary": "<short title>", "report": "<one paragraph: what you did, PR/issue links, checks run>" }`.
- Release every lock you hold. Never wait for human review — self-review and proceed autonomously; stop only when the operator pauses the swarm.
