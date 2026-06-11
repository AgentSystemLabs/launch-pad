import type { AgentType } from "./agent-bundle";

/** Path on the instance where the bundled agent is installed. */
export const TS_AGENT_INSTALL_PATH = "/opt/launch-pad/agent.cjs";
export const RUST_AGENT_INSTALL_PATH = "/opt/launch-pad/agent";

/** systemd unit restarted after a bundle swap. */
export const AGENT_SYSTEMD_UNIT = "launch-pad-agent";

export function agentInstallPath(agentType: AgentType): string {
  return agentType === "rust" ? RUST_AGENT_INSTALL_PATH : TS_AGENT_INSTALL_PATH;
}

/**
 * Bash script run on the instance: download the presigned bundle and restart the agent.
 * Passed to SSM as base64 to avoid quoting issues in presigned URLs.
 */
export function renderRemoteUpgradeScript(bundleUrl: string, agentType: AgentType = "ts"): string {
  const tmpPath = agentType === "rust" ? "/tmp/launch-pad-agent" : "/tmp/launch-pad-agent.cjs";
  const installPath = agentInstallPath(agentType);
  return `#!/bin/bash
set -euo pipefail
curl -fsSL ${shellQuote(bundleUrl)} -o ${tmpPath}
sudo install -m 755 ${tmpPath} ${installPath}
sudo systemctl restart ${AGENT_SYSTEMD_UNIT}
sudo systemctl is-active --quiet ${AGENT_SYSTEMD_UNIT}
`;
}

/** Wrap a script for SSM Run Shell (base64 avoids presigned-URL quoting pitfalls). */
export function ssmRunBashScript(script: string): string[] {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return [`echo ${encoded} | base64 -d | bash`];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
