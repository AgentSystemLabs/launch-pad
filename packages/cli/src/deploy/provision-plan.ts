import {
  type InstanceCapacity,
  type NodeRegistryEntry,
  type NodeRole,
  smallestInstanceTypeFor,
} from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";

/**
 * What `deploy` knows about a referenced node before deciding whether to
 * provision it — derived from the resolved service placements (which nodes a
 * service targets + the edge that fronts it), not the raw config.
 */
export interface NodeDemand {
  nodeId: string;
  /** Referenced as an edge (a web service routes through it). */
  isEdgeRef: boolean;
  /** Referenced as an app / placement target. */
  isAppTarget: boolean;
  /** A web service runs co-located here (no dedicated edge) → the node needs Caddy. */
  coLocatedWeb: boolean;
  /** Distinct edges fronting services placed here. */
  frontingEdges: string[];
  /** Summed cpu/memory demand placed here (shares / MB, already × replicas). */
  cpu: number;
  memory: number;
  /**
   * Transient rollout headroom to size for: the largest single-service surge on
   * this node (`min(maxSurge, replicas) × per-replica footprint`), so a freshly
   * provisioned node is born able to roll. Maxed per resource, since a node rolls
   * one service at a time. Defaults to 0.
   */
  surgeCpu?: number;
  surgeMemory?: number;
}

/**
 * Infer the role a referenced node must have — and, for a private `app` node,
 * the edge that fronts it. An `app` node is reachable only via its edge's
 * security group and runs no Caddy; a `both` node co-locates Caddy and is
 * publicly reachable; an `edge` node is a dedicated router.
 */
export function inferNodeRole(d: NodeDemand): { role: NodeRole; edgeNodeId?: string } {
  if (d.isEdgeRef && d.isAppTarget) return { role: "both" };
  if (d.isEdgeRef) return { role: "edge" };
  if (d.coLocatedWeb) return { role: "both" };
  // Private app node: only when fronted by exactly one edge (its SG references one).
  if (d.frontingEdges.length === 1) {
    const [edgeNodeId] = d.frontingEdges;
    return { role: "app", edgeNodeId };
  }
  // Worker-only, or fronted by multiple edges (can't pin a single edge SG) → co-located.
  return { role: "both" };
}

export type NodeAction =
  | { kind: "ready"; nodeId: string; entry: NodeRegistryEntry }
  | { kind: "resume"; nodeId: string; entry: NodeRegistryEntry }
  | {
      kind: "create";
      nodeId: string;
      role: NodeRole;
      edgeNodeId?: string;
      instanceType: string;
      capacity: InstanceCapacity;
    };

export interface BuildProvisionPlanArgs {
  demands: NodeDemand[];
  /** Load a node's registry entry from the (cluster-scoped) store, or null. */
  load: (nodeId: string) => Promise<NodeRegistryEntry | null>;
  /** When false, a missing node is a hard error (the pre-auto-provision behavior). */
  allowCreate: boolean;
  /** Auto-size floor passed to {@link smallestInstanceTypeFor} (default "t3.small"). */
  floor?: string;
}

/**
 * Partition every referenced node into an action: `ready` (exists, running),
 * `resume` (exists, paused), or `create` (missing → auto-sized + role inferred).
 * Pure except for the injected `load`, so it unit-tests without AWS.
 */
export async function buildProvisionPlan(args: BuildProvisionPlanArgs): Promise<NodeAction[]> {
  const actions: NodeAction[] = [];
  for (const d of args.demands) {
    const entry = await args.load(d.nodeId);
    if (entry) {
      actions.push(
        entry.state === "stopped"
          ? { kind: "resume", nodeId: d.nodeId, entry }
          : { kind: "ready", nodeId: d.nodeId, entry },
      );
      continue;
    }
    if (!args.allowCreate) {
      throw new CliError(`node "${d.nodeId}" does not exist`, {
        hint: "create it first, or drop --no-create to auto-provision it",
      });
    }
    const { role, edgeNodeId } = inferNodeRole(d);
    // Size for the rollout peak (steady + largest single surge), not just steady
    // state, so the node can do a zero-downtime surge from its first deploy on.
    const peakCpu = d.cpu + (d.surgeCpu ?? 0);
    const peakMemory = d.memory + (d.surgeMemory ?? 0);
    const sized = smallestInstanceTypeFor(peakCpu, peakMemory, { floor: args.floor });
    if (!sized) {
      throw new CliError(
        `no instance type fits node "${d.nodeId}" (${peakCpu} cpu shares · ${peakMemory} MB incl. rollout surge + reserved)`,
        { hint: "split services across more nodes, or pre-create the node with a larger instance type" },
      );
    }
    actions.push({
      kind: "create",
      nodeId: d.nodeId,
      role,
      edgeNodeId,
      instanceType: sized.instanceType,
      capacity: sized.capacity,
    });
  }
  return actions;
}
