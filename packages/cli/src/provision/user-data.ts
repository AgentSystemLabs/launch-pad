import type { NodeRole } from "@agentsystemlabs/launch-pad-shared";
import { renderCloudWatchInstall } from "./cloudwatch";
import { renderSystemdUnit } from "./systemd-unit";

export interface AgentConfig {
  nodeId: string;
  agentId: string;
  bucket: string;
  region: string;
  clusterId: string;
  role: NodeRole;
}

export interface UserDataParams {
  agent: AgentConfig;
  /** Presigned S3 URL the node curls to fetch the bundled agent. */
  bundleUrl: string;
}

/** Caddy install + permissive-admin systemd service (only for edge/both nodes). */
function caddyBlock(): string {
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
  return `# --- Caddy (static binary; the agent pushes routes via the admin API on :2019) ---
curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy
chmod +x /usr/local/bin/caddy
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
 * The cloud-init script a node runs on first boot: install Docker + Node (+ Caddy on
 * edge/both nodes), write the agent config + systemd unit, download the agent bundle
 * from a presigned S3 URL, then start it under systemd.
 */
export function renderUserData(params: UserDataParams): string {
  const agentJson = JSON.stringify(params.agent, null, 2);
  const unit = renderSystemdUnit();
  const caddy = params.agent.role === "app" ? "" : `\n${caddyBlock()}`;
  const cloudwatch = renderCloudWatchInstall({
    clusterId: params.agent.clusterId,
    nodeId: params.agent.nodeId,
    role: params.agent.role,
  });

  return `#!/bin/bash
set -euxo pipefail

# --- launch-pad dirs ---
mkdir -p /etc/launch-pad /var/lib/launch-pad /opt/launch-pad

# --- Docker ---
dnf install -y docker
systemctl enable --now docker

# --- Node.js 22 ---
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs
${caddy}
# --- launch-pad agent ---
cat > /etc/launch-pad/agent.json <<'AGENTCONF'
${agentJson}
AGENTCONF

curl -fsSL "${params.bundleUrl}" -o /opt/launch-pad/agent.cjs

cat > /etc/systemd/system/launch-pad-agent.service <<'UNIT'
${unit}UNIT

systemctl daemon-reload
systemctl enable --now launch-pad-agent

${cloudwatch}`;
}
