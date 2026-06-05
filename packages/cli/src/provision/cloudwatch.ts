import {
  type NodeRole,
  type SystemComponent,
  cwAgentConfig,
  systemComponentsForRole,
  systemCwConfig,
  systemLogFilePath,
  SYSTEM_LOG_DIR,
} from "@agentsystemlabs/launch-pad-shared";

/** CloudWatch Agent control binary + config paths on Amazon Linux 2023. */
const CW_AGENT_CTL = "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl";
const CW_BASE_CONFIG_PATH = "/opt/aws/amazon-cloudwatch-agent/etc/launch-pad-base.json";
/** Empty placeholder owned by the launch-pad agent (it writes cw-agent-combined.json on tick). */
const CW_CONTAINERS_FRAGMENT_PATH = "/etc/launch-pad/cw-agent-containers.json";

/** Source systemd unit each shipped component's journald is forwarded from. */
const COMPONENT_UNIT: Record<SystemComponent, string> = {
  agent: "launch-pad-agent.service",
  caddy: "caddy.service",
};

export interface CloudWatchInstallParams {
  clusterId: string;
  nodeId: string;
  role: NodeRole;
}

/**
 * A systemd unit that tails one component's journald output into a plain file the
 * CloudWatch Agent can ship. We forward (rather than redirect the service's
 * StandardOutput) so `journalctl -u <unit>` keeps working for on-box diagnosis.
 */
function forwarderUnit(component: SystemComponent): string {
  const sourceUnit = COMPONENT_UNIT[component];
  const logFile = systemLogFilePath(component);
  return `[Unit]
Description=launch-pad CloudWatch log forwarder (${component})
After=${sourceUnit}

[Service]
ExecStart=/bin/sh -c 'exec journalctl -n 0 -f -u ${sourceUnit} -o cat'
StandardOutput=append:${logFile}
StandardError=append:${logFile}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Bash that installs + enables the Amazon CloudWatch Agent with the node's **base**
 * config (system logs: agent journald, plus caddy on edge/both). Idempotent, so it is
 * safe to run again on an existing node via `node install-logging`. The launch-pad
 * agent supplements this with the dynamic per-container config on its next tick.
 *
 * Designed to be embedded inside a `set -euxo pipefail` script (user-data) — it assumes
 * /etc/launch-pad already exists.
 */
export function renderCloudWatchInstall(params: CloudWatchInstallParams): string {
  const { clusterId, nodeId, role } = params;
  const baseConfig = JSON.stringify(systemCwConfig(clusterId, nodeId, role), null, 2);
  const emptyFragment = JSON.stringify(cwAgentConfig([]), null, 2);
  const components = systemComponentsForRole(role);

  const forwarders = components
    .map((component) => {
      const unitName = `launch-pad-logforward-${component}`;
      return `cat > /etc/systemd/system/${unitName}.service <<'LPFWD_${component.toUpperCase()}'
${forwarderUnit(component)}LPFWD_${component.toUpperCase()}
systemctl enable --now ${unitName}.service`;
    })
    .join("\n");

  return `# --- Amazon CloudWatch Agent (ships app stdout + agent/caddy journald) ---
dnf install -y amazon-cloudwatch-agent
mkdir -p ${SYSTEM_LOG_DIR} /opt/aws/amazon-cloudwatch-agent/etc

${forwarders}

cat > ${CW_BASE_CONFIG_PATH} <<'CWBASE'
${baseConfig}
CWBASE

# Agent-owned placeholder; the launch-pad agent writes cw-agent-combined.json each tick.
cat > ${CW_CONTAINERS_FRAGMENT_PATH} <<'CWFRAG'
${emptyFragment}
CWFRAG

${CW_AGENT_CTL} -a fetch-config -m ec2 -s -c file:${CW_BASE_CONFIG_PATH}
`;
}

/** Standalone script (shebang + strict mode) for running the install over SSM on an existing node. */
export function renderCloudWatchInstallScript(params: CloudWatchInstallParams): string {
  return `#!/bin/bash
set -euxo pipefail
mkdir -p /etc/launch-pad
${renderCloudWatchInstall(params)}`;
}
