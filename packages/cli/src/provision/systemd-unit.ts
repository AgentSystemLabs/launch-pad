/** The systemd unit that keeps the launch-pad agent running on a node. */
export function renderSystemdUnit(): string {
  return `[Unit]
Description=launch-pad agent
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env node /opt/launch-pad/agent.cjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
}
