import type { NodeStatus } from "@agentsystemlabs/launch-pad-shared";

/**
 * Match the agent's `parse_desired_state` reject message:
 * `unsupported desired.json version N (expected M)`.
 *
 * When the CLI publishes a newer PROTOCOL_VERSION than the on-box agent
 * understands, reconcile fails every tick and deploy hangs on convergence —
 * this is the message that lands in `status.json` (today under `caddy.error`
 * via `heartbeat_status`, because app agents reuse that field for tick-level
 * failures).
 */
const PROTOCOL_MISMATCH_RE =
  /unsupported desired\.json version\s+(\d+)\s+\(expected\s+(\d+)\)/i;

export interface ProtocolMismatch {
  nodeId: string;
  publishedVersion: number;
  agentExpectedVersion: number;
  /** Raw agent error text (for logs / JSON). */
  message: string;
}

/** Extract a protocol mismatch from an agent status, if one is currently reported. */
export function detectProtocolMismatch(
  nodeId: string,
  status: NodeStatus | null | undefined,
): ProtocolMismatch | null {
  const error = status?.caddy?.error;
  if (!error) return null;
  const match = PROTOCOL_MISMATCH_RE.exec(error);
  if (!match) return null;
  return {
    nodeId,
    publishedVersion: Number(match[1]),
    agentExpectedVersion: Number(match[2]),
    message: error.trim(),
  };
}

/** Operator-facing remediation for a protocol mismatch. */
export function protocolMismatchHint(m: ProtocolMismatch): string {
  return (
    `node ${m.nodeId} agent expects desired.json v${m.agentExpectedVersion} ` +
    `but this CLI published v${m.publishedVersion} — upgrade the node agent: ` +
    `launchpad node upgrade-agent --yes`
  );
}
