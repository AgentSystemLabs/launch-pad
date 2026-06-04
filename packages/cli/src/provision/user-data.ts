import { renderSystemdUnit } from "./systemd-unit";

export interface AgentConfig {
  nodeId: string;
  agentId: string;
  bucket: string;
  region: string;
}

export interface UserDataParams {
  agent: AgentConfig;
  /** Presigned S3 URL the node curls to fetch the bundled agent. */
  bundleUrl: string;
}

/**
 * The cloud-init script a node runs on first boot: install Docker + Node + Caddy,
 * write the agent config + systemd unit, download the agent bundle from a presigned
 * S3 URL, then start it under systemd.
 */
export function renderUserData(params: UserDataParams): string {
  const agentJson = JSON.stringify(params.agent, null, 2);
  const unit = renderSystemdUnit();

  return `#!/bin/bash
set -euxo pipefail

# --- Docker ---
dnf install -y docker
systemctl enable --now docker

# --- Node.js 22 ---
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs

# --- Caddy (static binary; the agent pushes routes via the admin API on :2019) ---
curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy
chmod +x /usr/local/bin/caddy
mkdir -p /var/lib/caddy /etc/launch-pad /var/lib/launch-pad /opt/launch-pad

# Boot Caddy with a permissive admin config so the agent (loopback, no Origin
# header) can push routes; the agent re-includes this admin block on every reload.
cat > /etc/launch-pad/caddy-init.json <<'CADDYINIT'
{
  "admin": {
    "listen": "127.0.0.1:2019",
    "origins": ["", "127.0.0.1:2019", "localhost:2019", "[::1]:2019"]
  }
}
CADDYINIT

cat > /etc/systemd/system/caddy.service <<'CADDYUNIT'
[Unit]
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
CADDYUNIT
systemctl daemon-reload
systemctl enable --now caddy

# --- launch-pad agent ---
mkdir -p /etc/launch-pad /var/lib/launch-pad /opt/launch-pad

cat > /etc/launch-pad/agent.json <<'AGENTCONF'
${agentJson}
AGENTCONF

curl -fsSL "${params.bundleUrl}" -o /opt/launch-pad/agent.cjs

cat > /etc/systemd/system/launch-pad-agent.service <<'UNIT'
${unit}UNIT

systemctl daemon-reload
systemctl enable --now launch-pad-agent
`;
}
