# Loop: idea

1. Play or skim README + `src/` to find one **small** improvement (not a rewrite).
2. Open a GitHub issue titled `idea: <short title>` with acceptance criteria (3 bullets max).
3. Label: `swarm`, `idea`, `triage`.
4. `wal_append` + comment on tracking issue with issue link.
5. **Do not implement in this session** unless the issue is trivial (<20 LOC).

## Close out (required)

- Heartbeat with MCP `agent_status` when you start and whenever your focus shifts.
- Stream notable progress lines with MCP `stdout_append` (key steps, not every token) so the operator can watch live.
- Finish with MCP `wal_append` `{ "event": "done", "loop": "<this-loop>", "summary": "<short title>", "report": "<one paragraph: what you did, PR/issue links, checks run>" }`.
- Release every lock you hold. Never wait for human review — self-review and proceed autonomously; stop only when the operator pauses the swarm.
