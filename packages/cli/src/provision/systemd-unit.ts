import type { AgentType } from "./agent-bundle";

/** The systemd unit that keeps the launch-pad agent running on a node. */
export function renderSystemdUnit(agentType: AgentType = "ts"): string {
  const exec =
    agentType === "rust"
      ? "/opt/launch-pad/agent"
      : "/usr/bin/env node /opt/launch-pad/agent.cjs";
  return `[Unit]
Description=launch-pad agent
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
}
