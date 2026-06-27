# Loop: security-review

1. Pick one surface: WebSocket auth, chat XSS, voice/WebRTC signaling, static file serving, or dependency exposure.
2. Document threat + impact in a GitHub issue (`security: <topic>`), labels `swarm`, `security`.
3. If fix is localized, open PR; never disable security checks to green CI.
4. No secrets in issues or PR bodies.

## Close out (required)

- Heartbeat with MCP `agent_status` when you start and whenever your focus shifts.
- Stream notable progress lines with MCP `stdout_append` (key steps, not every token) so the operator can watch live.
- Finish with MCP `wal_append` `{ "event": "done", "loop": "<this-loop>", "summary": "<short title>", "report": "<one paragraph: what you did, PR/issue links, checks run>" }`.
- Release every lock you hold. Never wait for human review — self-review and proceed autonomously; stop only when the operator pauses the swarm.
