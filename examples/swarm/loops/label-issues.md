# Loop: label-issues

1. `gh issue list --state open --limit 50` — triage unlabeled or `triage` issues.
2. Add labels: type (`bug`, `idea`, `ux`, `security`), priority, `swarm`.
3. Export a markdown table to a comment on the **tracking issue** (issue # in env).
4. Close duplicates with cross-links.
5. No code changes this session.

## Close out (required)

- Heartbeat with MCP `agent_status` when you start and whenever your focus shifts.
- Stream notable progress lines with MCP `stdout_append` (key steps, not every token) so the operator can watch live.
- Finish with MCP `wal_append` `{ "event": "done", "loop": "<this-loop>", "summary": "<short title>", "report": "<one paragraph: what you did, PR/issue links, checks run>" }`.
- Release every lock you hold. Never wait for human review — self-review and proceed autonomously; stop only when the operator pauses the swarm.
