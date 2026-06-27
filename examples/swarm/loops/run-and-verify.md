# Loop: run-and-verify

1. `npm ci && npm run build && npm test` (if test script exists).
2. Run **one** script under `scripts/` relevant to recent PRs (e.g. `browser-test.mjs`, `ws-test.mjs`).
3. Post results on tracking issue: pass/fail, command, exit code, 3-line summary.
4. If failure, open a `bug:` issue with logs — do not fix in this session unless trivial typo.
5. `wal_append` `{ "event": "verify", "script": "…", "exit": N }`.

## Close out (required)

- Heartbeat with MCP `agent_status` when you start and whenever your focus shifts.
- Stream notable progress lines with MCP `stdout_append` (key steps, not every token) so the operator can watch live.
- Finish with MCP `wal_append` `{ "event": "done", "loop": "<this-loop>", "summary": "<short title>", "report": "<one paragraph: what you did, PR/issue links, checks run>" }`.
- Release every lock you hold. Never wait for human review — self-review and proceed autonomously; stop only when the operator pauses the swarm.
