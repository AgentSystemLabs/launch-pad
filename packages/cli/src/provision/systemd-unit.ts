import type { ProvisionNodeRole } from "@agentsystemlabs/launch-pad-shared";

/**
 * The systemd unit that keeps the launchpad agent (a self-contained Rust binary at
 * /opt/launch-pad/agent) running on a node. Role-specific: only the app agent talks
 * to Docker, so only the app unit orders/wants docker.service — the edge AMI doesn't
 * even have Docker installed.
 */
export function renderSystemdUnit(role: ProvisionNodeRole): string {
  const after = role === "app" ? "docker.service network-online.target" : "network-online.target";
  return `[Unit]
Description=launchpad agent (${role})
After=${after}
Wants=${after}

[Service]
Type=simple
ExecStart=/opt/launch-pad/agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}
