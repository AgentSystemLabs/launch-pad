import type { NodeRole, NodeState } from "@agentsystemlabs/launch-pad-shared";
import { estimateEc2Monthly } from "./estimate";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How idle a node is wasting money. */
export type IdleKind = "paused" | "empty";

/** Default age (days) before an idle node is worth flagging. */
export const DEFAULT_MIN_IDLE_DAYS = 7;

/**
 * One node, projected to just the signals the idle heuristic reads: its registry
 * identity + lifecycle, the agent's last heartbeat (`status.json`), how many
 * services are scheduled to it (`desired.json`), and — for edge nodes — how many
 * domains it currently routes (`status.json` edgeRoutes).
 */
export interface IdleNodeInput {
  nodeId: string;
  role: NodeRole;
  instanceType: string;
  state: NodeState;
  /** ISO node-creation timestamp (always present). */
  createdAt: string;
  /** ISO heartbeat from status.json, or null if the node has never reported. */
  lastSeen: string | null;
  /** Services scheduled to this node (desired.json service count). */
  desiredServices: number;
  /** Domains an edge node is routing (status.json edgeRoutes); null when unknown. */
  edgeRoutes: number | null;
}

export interface IdleRecommendation {
  nodeId: string;
  role: NodeRole;
  instanceType: string;
  kind: IdleKind;
  /** Whole days the node has been idle (floored). */
  idleDays: number;
  /**
   * Estimated monthly USD wasted: the full EC2 rate for a running-but-empty node.
   * Null for a paused node — its compute isn't billed, only EBS + Elastic IP (not
   * dollar-estimated here, same as the provision-time estimate).
   */
  monthlyWasteUsd: number | null;
  message: string;
  hint: string;
}

function idleDaysSince(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

/**
 * Flag nodes that are costing money without doing work:
 *
 *  - **paused** — a `stopped` instance still incurs EBS volume + Elastic IP charges.
 *    Dated from its last heartbeat (≈ when it stopped), falling back to `createdAt`.
 *  - **empty** — a `ready` app/both node hosting zero services, or an `edge` node
 *    routing zero domains, burns its full EC2 rate for nothing. Dated from `createdAt`
 *    (we don't track "empty since", so only flag a node that's existed past the
 *    threshold). An edge node with unknown routing (no status.json yet) is never flagged.
 *
 * `provisioning` / `terminating` / `terminated` nodes are ignored. Results are sorted
 * most-idle first. Pure — `nowMs` and all timestamps are passed in.
 */
export function recommendIdleNodes(
  nodes: IdleNodeInput[],
  nowMs: number,
  opts?: { minIdleDays?: number },
): IdleRecommendation[] {
  const minIdleDays = opts?.minIdleDays ?? DEFAULT_MIN_IDLE_DAYS;
  const recs: IdleRecommendation[] = [];

  for (const n of nodes) {
    if (n.state === "stopped") {
      const idleDays = idleDaysSince(n.lastSeen ?? n.createdAt, nowMs);
      if (idleDays < minIdleDays) continue;
      recs.push({
        nodeId: n.nodeId,
        role: n.role,
        instanceType: n.instanceType,
        kind: "paused",
        idleDays,
        monthlyWasteUsd: null,
        message: `paused ${idleDays}d — still incurring EBS volume + Elastic IP charges`,
        hint: `resume it (\`node resume ${n.nodeId}\`) or tear it down (\`node destroy ${n.nodeId}\`)`,
      });
      continue;
    }

    if (n.state !== "ready") continue;

    const isEmpty =
      n.role === "edge"
        ? n.edgeRoutes === 0 // null = unknown routing → never flag
        : n.desiredServices === 0;
    if (!isEmpty) continue;

    const idleDays = idleDaysSince(n.createdAt, nowMs);
    if (idleDays < minIdleDays) continue;
    const monthlyWasteUsd = estimateEc2Monthly(n.instanceType);
    recs.push({
      nodeId: n.nodeId,
      role: n.role,
      instanceType: n.instanceType,
      kind: "empty",
      idleDays,
      monthlyWasteUsd,
      message:
        n.role === "edge"
          ? `running ${idleDays}d but routing no domains`
          : `running ${idleDays}d but hosts no services`,
      hint: `deploy to it or tear it down (\`node destroy ${n.nodeId}\`)`,
    });
  }

  return recs.sort((a, b) => b.idleDays - a.idleDays || a.nodeId.localeCompare(b.nodeId));
}
