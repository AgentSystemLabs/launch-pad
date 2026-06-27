# Loop: bug-report

1. `git pull` — scan recent commits or run `node scripts/browser-test.mjs` if dependencies allow.
2. Reproduce **one** bug; record repro steps.
3. File GitHub issue: `bug: <title>`, labels `swarm`, `bug`, plus severity `p1`/`p2`/`p3`.
4. If fix is <30 LOC and obvious, branch `swarm/bug-<issue>-<agent>` and open PR; else issue only.
5. WAL `task_done` with issue/PR links.

## Close out (required)

- Heartbeat with MCP `agent_status` when you start and whenever your focus shifts.
- Stream notable progress lines with MCP `stdout_append` (key steps, not every token) so the operator can watch live.
- Finish with MCP `wal_append` `{ "event": "done", "loop": "<this-loop>", "summary": "<short title>", "report": "<one paragraph: what you did, PR/issue links, checks run>" }`.
- Release every lock you hold. Never wait for human review — self-review and proceed autonomously; stop only when the operator pauses the swarm.
