import {
  caddyArchForArchitecture,
  type NodeArchitecture,
  type NodeRole,
} from "@agentsystemlabs/launch-pad-shared";
import { renderCloudWatchInstall } from "./cloudwatch";
import { renderSystemdUnit } from "./systemd-unit";

export interface AgentConfig {
  nodeId: string;
  agentId: string;
  bucket: string;
  region: string;
  clusterId: string;
  role: NodeRole;
  /**
   * External (BYOS) nodes only: the IP the edge dials to reach this node's container
   * host ports. The agent advertises this in its upstream shard instead of the
   * EC2-metadata private IP. EC2 nodes omit it (rendering is unchanged for them).
   */
  advertiseIp?: string;
}

export interface UserDataParams {
  agent: AgentConfig;
  architecture: NodeArchitecture;
  /** Presigned S3 URL the node curls to fetch the agent binary (full bootstrap only). */
  agentBinaryUrl?: string;
  /** Golden AMIs already include host dependencies and the role's agent binary. */
  bootstrapMode?: "full" | "golden";
}

/** Caddy install + permissive-admin systemd service (only for the edge node). */
function caddyBlock(installBinary: boolean, architecture: NodeArchitecture): string {
  const unit = `[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
Environment=XDG_DATA_HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/launch-pad/caddy-init.json
Restart=always
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`;
  const binaryBlock = installBinary
    ? `curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${caddyArchForArchitecture(architecture)}" -o /usr/local/bin/caddy
chmod +x /usr/local/bin/caddy`
    : "test -x /usr/local/bin/caddy";

  return `# --- Caddy (static binary; the agent pushes routes via the admin API on :2019) ---
${binaryBlock}
mkdir -p /var/lib/caddy

cat > /etc/launch-pad/caddy-init.json <<'CADDYINIT'
{
  "admin": {
    "listen": "127.0.0.1:2019",
    "origins": ["", "127.0.0.1:2019", "localhost:2019", "[::1]:2019"]
  }
}
CADDYINIT

cat > /etc/systemd/system/caddy.service <<'CADDYUNIT'
${unit}CADDYUNIT
systemctl daemon-reload
systemctl enable --now caddy
`;
}

/**
 * The cloud-init script a node runs on first boot — strictly role-specific:
 *
 *   - edge: Caddy + CloudWatch + the edge agent binary. No Docker, no Node.js.
 *   - app:  Docker + CloudWatch + the app agent binary. No Caddy, no Node.js.
 *
 * On a golden AMI everything is pre-baked and first boot only writes node-specific
 * config; a full bootstrap installs the role's stack and curls the agent binary from
 * a presigned S3 URL.
 */
export function renderUserData(params: UserDataParams): string {
  const bootstrapMode = params.bootstrapMode ?? "full";
  const role = params.agent.role;
  const agentJson = JSON.stringify(params.agent, null, 2);
  const unit = renderSystemdUnit(role === "app" ? "app" : "edge");
  const caddy = role === "app" ? "" : `\n${caddyBlock(bootstrapMode === "full", params.architecture)}`;
  const cloudwatch = renderCloudWatchInstall({
    clusterId: params.agent.clusterId,
    nodeId: params.agent.nodeId,
    role,
    installPackage: bootstrapMode === "full",
  });

  if (bootstrapMode === "full" && !params.agentBinaryUrl) {
    throw new Error("agentBinaryUrl is required for full bootstrap");
  }

  const fetchAgent =
    bootstrapMode === "golden"
      ? `# --- agent binary baked into the launchpad golden AMI ---
test -x /opt/launch-pad/agent`
      : `# --- launchpad agent binary (role: ${role}) ---
curl -fsSL "${params.agentBinaryUrl}" -o /opt/launch-pad/agent
chmod +x /opt/launch-pad/agent`;

  const dockerBlock =
    role === "app"
      ? bootstrapMode === "full"
        ? `# --- Docker ---
dnf install -y docker
systemctl enable --now docker
`
        : `# --- Docker (preinstalled by launchpad golden AMI) ---
systemctl enable --now docker
`
      : "";

  return `#!/bin/bash
set -euxo pipefail

# --- launchpad dirs ---
mkdir -p /etc/launch-pad /var/lib/launch-pad /opt/launch-pad

${dockerBlock}${caddy}
# --- launchpad agent ---
cat > /etc/launch-pad/agent.json <<'AGENTCONF'
${agentJson}
AGENTCONF

${fetchAgent}

cat > /etc/systemd/system/launch-pad-agent.service <<'UNIT'
${unit}UNIT

systemctl daemon-reload
systemctl enable --now launch-pad-agent

${cloudwatch}`;
}
