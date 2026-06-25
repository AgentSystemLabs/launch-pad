import type { ProvisionNodeRole } from "@agentsystemlabs/launch-pad-shared";

/**
 * The systemd unit that keeps the launchpad agent (a self-contained Rust binary at
 * /opt/launch-pad/agent) running on a node. Role-specific: only the app agent talks
 * to Docker, so only the app unit orders/wants docker.service — the edge AMI doesn't
 * even have Docker installed.
 *
 * `opts.environmentFile` injects a single `EnvironmentFile=` line into `[Service]` —
 * used by external (BYOS) nodes, which carry their AWS credentials in a file
 * (`/etc/launch-pad/agent.env`) instead of an EC2 instance-profile. The DEFAULT
 * output (no opts) is byte-identical to the EC2/golden-AMI unit; do not change it.
 */
export function renderSystemdUnit(
  role: ProvisionNodeRole,
  opts?: { environmentFile?: string },
): string {
  const after = role === "app" ? "docker.service network-online.target" : "network-online.target";
  const environmentFile = opts?.environmentFile
    ? `EnvironmentFile=${opts.environmentFile}\n`
    : "";
  return `[Unit]
Description=launchpad agent (${role})
After=${after}
Wants=${after}

[Service]
Type=simple
${environmentFile}ExecStart=/opt/launch-pad/agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}
