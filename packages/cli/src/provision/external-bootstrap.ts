import {
  SYSTEM_LOG_DIR,
  type SystemComponent,
  systemComponentsForRole,
  systemLogFilePath,
} from "@agentsystemlabs/launch-pad-shared";
import { AGENT_INSTALL_PATH, AGENT_SYSTEMD_UNIT } from "./agent-upgrade";
import { shellQuote } from "./shell-quote";

/** Where external (BYOS) nodes keep their AWS credentials, loaded via systemd EnvironmentFile. */
export const AGENT_ENV_FILE = "/etc/launch-pad/agent.env";

export interface ExternalBootstrapParams {
  role: "app" | "edge";
  /** The JSON written to /etc/launch-pad/agent.json (already serialized by the caller). */
  agentConfigJson: string;
  /** Presigned (or otherwise reachable) URL the host curls to fetch the role's agent binary. */
  agentBinaryUrl: string;
  /** The systemd unit text (rendered with `EnvironmentFile=${AGENT_ENV_FILE}`). */
  systemdUnit: string;
  aws: { accessKeyId: string; secretAccessKey: string; region: string };
}

export interface ExternalCredentialsParams {
  aws: { accessKeyId: string; secretAccessKey: string; region: string };
}

const COMPONENT_UNIT: Record<SystemComponent, string> = {
  agent: `${AGENT_SYSTEMD_UNIT}.service`,
  caddy: "caddy.service",
};

function forwarderUnit(component: SystemComponent): string {
  const sourceUnit = COMPONENT_UNIT[component];
  const logFile = systemLogFilePath(component);
  return `[Unit]
Description=launch-pad direct log forwarder (${component})
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

function caddyBlock(): string {
  return `# --- Caddy (edge role only; static binary, admin API on 127.0.0.1:2019) ---
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
systemctl enable --now caddy
`;
}

/**
 * Render the bash bootstrap script an operator runs (as root) on their own server to
 * enroll it as an external (BYOS) launchpad node. PURE — no I/O, no secrets logged: the
 * script writes the AWS credentials ONLY into a chmod-600 `agent.env` (loaded by systemd
 * via `EnvironmentFile=`), never echoing them. App nodes additionally install Docker.
 *
 * Package-manager agnostic: detects `dnf` (Amazon Linux / Fedora / RHEL) then `apt-get`
 * (Debian / Ubuntu); anything else fails closed with a clear stderr message so an
 * unsupported host can't half-enroll.
 */
export function renderExternalBootstrap(p: ExternalBootstrapParams): string {
  const { role, agentConfigJson, agentBinaryUrl, systemdUnit, aws } = p;
  const forwarders = systemComponentsForRole(role)
    .map((component) => {
      const unitName = `launch-pad-logforward-${component}`;
      return `cat > /etc/systemd/system/${unitName}.service <<'LPFWD_${component.toUpperCase()}'
${forwarderUnit(component)}LPFWD_${component.toUpperCase()}`;
    })
    .join("\n");
  const enableForwarders = systemComponentsForRole(role)
    .map((component) => `systemctl enable --now launch-pad-logforward-${component}`)
    .join("\n");

  // App nodes need Docker; the edge router does not. Installed via whichever package
  // manager the detection block resolved into $PKG_INSTALL.
  const dockerBlock =
    role === "app"
      ? `# --- Docker (app role only) ---
$PKG_INSTALL docker
systemctl enable --now docker
`
      : "";
  const edgeBlock = role === "edge" ? caddyBlock() : "";

  return `#!/bin/bash
set -euxo pipefail

# --- detect package manager (dnf: Amazon Linux/Fedora/RHEL; apt-get: Debian/Ubuntu) ---
if command -v dnf >/dev/null 2>&1; then
  PKG_INSTALL="dnf install -y"
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  PKG_INSTALL="apt-get install -y"
else
  echo "launchpad: unsupported host — neither dnf nor apt-get found" >&2
  exit 1
fi

# --- launchpad dirs ---
mkdir -p /etc/launch-pad /opt/launch-pad /var/lib/launch-pad ${SYSTEM_LOG_DIR}

${dockerBlock}${edgeBlock}

# --- AWS credentials (loaded by systemd EnvironmentFile; never logged elsewhere) ---
touch ${AGENT_ENV_FILE}
chmod 600 ${AGENT_ENV_FILE}
cat > ${AGENT_ENV_FILE} <<'AGENTENV'
AWS_ACCESS_KEY_ID=${aws.accessKeyId}
AWS_SECRET_ACCESS_KEY=${aws.secretAccessKey}
AWS_REGION=${aws.region}
AGENTENV

# --- agent config ---
touch /etc/launch-pad/agent.json
chmod 600 /etc/launch-pad/agent.json
cat > /etc/launch-pad/agent.json <<'AGENTCONF'
${agentConfigJson}
AGENTCONF

# --- launchpad agent binary (role: ${role}) ---
curl -fsSL ${shellQuote(agentBinaryUrl)} -o ${AGENT_INSTALL_PATH}
chmod 755 ${AGENT_INSTALL_PATH}

# --- systemd unit ---
cat > /etc/systemd/system/${AGENT_SYSTEMD_UNIT}.service <<'UNIT'
${systemdUnit}UNIT

# --- journald forwarders for direct CloudWatch Logs shipping ---
${forwarders}

systemctl daemon-reload
${enableForwarders}
systemctl enable --now ${AGENT_SYSTEMD_UNIT}
`;
}

/** Rewrite only the external node's AWS credential file, then restart the agent. */
export function renderExternalCredentialsUpdate(p: ExternalCredentialsParams): string {
  const { aws } = p;
  return `#!/bin/bash
set -euo pipefail
touch ${AGENT_ENV_FILE}
chmod 600 ${AGENT_ENV_FILE}
cat > ${AGENT_ENV_FILE} <<'AGENTENV'
AWS_ACCESS_KEY_ID=${aws.accessKeyId}
AWS_SECRET_ACCESS_KEY=${aws.secretAccessKey}
AWS_REGION=${aws.region}
AGENTENV
systemctl restart ${AGENT_SYSTEMD_UNIT}
systemctl is-active --quiet ${AGENT_SYSTEMD_UNIT}
`;
}
