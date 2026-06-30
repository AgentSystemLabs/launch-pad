import type { ProvisionNodeRole } from "@agentsystemlabs/launch-pad-shared";
import { renderSystemdUnit } from "./systemd-unit";
import { shellQuote } from "./shell-quote";

/** Path on the instance where the agent binary is installed. */
export const AGENT_INSTALL_PATH = "/opt/launch-pad/agent";

/** Where the legacy TypeScript bundle lived — removed by the upgrade script. */
export const LEGACY_TS_AGENT_PATH = "/opt/launch-pad/agent.cjs";

/** systemd unit restarted after a binary swap. */
export const AGENT_SYSTEMD_UNIT = "launch-pad-agent";

/**
 * Bash script run on the instance: download the presigned role-specific Rust binary,
 * install it, REWRITE the systemd unit (a node migrating from the TypeScript agent
 * still has `ExecStart=node agent.cjs`), and restart. On an edge node it also stops
 * Docker — the whole point of the role split is that an edge doesn't pay for an idle
 * Docker daemon (an edge never runs containers, so this is safe).
 *
 * Passed to SSM as base64 to avoid quoting issues in presigned URLs.
 */
export function renderRemoteUpgradeScript(binaryUrl: string, role: ProvisionNodeRole): string {
  const unit = renderSystemdUnit(role);
  const edgeExtras =
    role === "edge"
      ? `# Edge nodes never run containers — stop paying for an idle Docker daemon.
sudo systemctl disable --now docker 2>/dev/null || true
`
      : "";
  return `#!/bin/bash
set -euo pipefail
staged="$(mktemp)"
curl -fsSL ${shellQuote(binaryUrl)} -o "$staged"
sudo install -m 755 "$staged" ${AGENT_INSTALL_PATH}
rm -f "$staged"
sudo tee /etc/systemd/system/${AGENT_SYSTEMD_UNIT}.service > /dev/null <<'UNIT'
${unit}UNIT
sudo rm -f ${LEGACY_TS_AGENT_PATH}
${edgeExtras}sudo systemctl daemon-reload
sudo systemctl restart ${AGENT_SYSTEMD_UNIT}
sudo systemctl is-active --quiet ${AGENT_SYSTEMD_UNIT}
`;
}

/** Wrap a script for SSM Run Shell (base64 avoids presigned-URL quoting pitfalls). */
export function ssmRunBashScript(script: string): string[] {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return [`echo ${encoded} | base64 -d | bash`];
}
