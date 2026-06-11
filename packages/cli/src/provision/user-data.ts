import type { NodeRole } from "@agentsystemlabs/launch-pad-shared";
import type { AgentType } from "./agent-bundle";
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
  /** Presigned S3 URL the node curls to fetch the agent artifact. */
  bundleUrl?: string;
  /** Agent runtime: "ts" (Node CJS bundle, default) or "rust" (static binary). */
  agentType?: AgentType;
  /** Golden AMIs already include host dependencies and the Rust agent binary. */
  bootstrapMode?: "full" | "golden";
}

/** Caddy install + permissive-admin systemd service (only for edge/both nodes). */
function caddyBlock(installBinary: boolean): string {
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
    ? `curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy
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

function needsAgentDownload(agentType: AgentType, bootstrapMode: "full" | "golden"): boolean {
  return bootstrapMode === "full" || agentType === "ts";
}

/**
 * The cloud-init script a node runs on first boot: install Docker + Node (+ Caddy on
 * edge/both nodes), write the agent config + systemd unit, download the agent bundle
 * from a presigned S3 URL, then start it under systemd.
 */
export function renderUserData(params: UserDataParams): string {
  const agentType = params.agentType ?? "ts";
  const bootstrapMode = params.bootstrapMode ?? "full";
  const agentJson = JSON.stringify(params.agent, null, 2);
  const unit = renderSystemdUnit(agentType);
  const caddy = params.agent.role === "app" ? "" : `\n${caddyBlock(bootstrapMode === "full")}`;
  const cloudwatch = renderCloudWatchInstall({
    clusterId: params.agent.clusterId,
    nodeId: params.agent.nodeId,
    role: params.agent.role,
    installPackage: bootstrapMode === "full",
  });

  // The Rust agent is a self-contained binary — no Node runtime needed on-box.
  const runtimeBlock =
    bootstrapMode === "golden"
      ? `# --- runtime already installed by launch-pad golden AMI ---
${agentType === "rust" ? "test -x /opt/launch-pad/agent" : "node --version"}`
      : agentType === "rust"
      ? `# --- agent runtime: Rust (static binary, no Node needed) ---`
      : `# --- Node.js 22 ---
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs`;

  if (needsAgentDownload(agentType, bootstrapMode) && !params.bundleUrl) {
    throw new Error(`bundleUrl is required for ${agentType} agent on ${bootstrapMode} bootstrap`);
  }

  const fetchAgent =
    bootstrapMode === "golden" && agentType === "rust"
      ? "# Rust agent binary is baked into the launch-pad golden AMI."
      : agentType === "rust"
        ? `curl -fsSL "${params.bundleUrl}" -o /opt/launch-pad/agent
chmod +x /opt/launch-pad/agent`
        : `curl -fsSL "${params.bundleUrl}" -o /opt/launch-pad/agent.cjs`;

  const dockerBlock =
    bootstrapMode === "full"
      ? `# --- Docker ---
dnf install -y docker
systemctl enable --now docker`
      : `# --- Docker (preinstalled by launch-pad golden AMI) ---
systemctl enable --now docker`;

  return `#!/bin/bash
set -euxo pipefail

# --- launch-pad dirs ---
mkdir -p /etc/launch-pad /var/lib/launch-pad /opt/launch-pad

${dockerBlock}

${runtimeBlock}
${caddy}
# --- launch-pad agent ---
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
