import {
  DEFAULT_EDGE_INSTANCE_TYPE,
  type InstanceCapacity,
  type NodeRegistryEntry,
  type NodeRole,
  lookupInstanceCapacity,
  nodeFrontsIngress,
  smallestInstanceTypeFor,
} from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";

/**
 * What `deploy` knows about an app node before deciding whether to provision it —
 * derived from the resolved service placements. Every demand is an APP node; the
 * cluster's dedicated edge is planned separately ({@link planEdgeAction}) because
 * it hosts no containers and has no capacity demand.
 */
export interface NodeDemand {
  nodeId: string;
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
  /** The cluster's dedicated edge — every created app node is fronted by it. */
  edgeNodeId: string;
  /** Load a node's registry entry from the (cluster-scoped) store, or null. */
  load: (nodeId: string) => Promise<NodeRegistryEntry | null>;
  /** When false, a missing node is a hard error (the pre-auto-provision behavior). */
  allowCreate: boolean;
  /** Auto-size floor passed to {@link smallestInstanceTypeFor} (default "t3.small"). */
  floor?: string;
}

/**
 * Plan the cluster's dedicated edge node: `ready` (exists, running), `resume`
 * (exists, paused), or `create` ({@link DEFAULT_EDGE_INSTANCE_TYPE} — the edge
 * only runs Caddy, so the smallest burstable type is plenty).
 */
export async function planEdgeAction(args: {
  edgeNodeId: string;
  load: (nodeId: string) => Promise<NodeRegistryEntry | null>;
  allowCreate: boolean;
}): Promise<NodeAction> {
  const entry = await args.load(args.edgeNodeId);
  if (entry) {
    if (!nodeFrontsIngress(entry.role)) {
      throw new CliError(
        `node "${args.edgeNodeId}" is the cluster's edge but has role "${entry.role}"`,
        { hint: "set the cluster's default edge to an edge-role node: launchpad cluster set-edge" },
      );
    }
    return entry.state === "stopped"
      ? { kind: "resume", nodeId: args.edgeNodeId, entry }
      : { kind: "ready", nodeId: args.edgeNodeId, entry };
  }
  if (!args.allowCreate) {
    throw new CliError(`edge node "${args.edgeNodeId}" does not exist`, {
      hint: "create it first, or drop --no-create to auto-provision it",
    });
  }
  const capacity = lookupInstanceCapacity(DEFAULT_EDGE_INSTANCE_TYPE);
  if (!capacity) {
    throw new CliError(`unknown instance type "${DEFAULT_EDGE_INSTANCE_TYPE}" for the edge node`);
  }
  return {
    kind: "create",
    nodeId: args.edgeNodeId,
    role: "edge",
    instanceType: DEFAULT_EDGE_INSTANCE_TYPE,
    capacity,
  };
}

/**
 * Partition every app node the placement targets into an action: `ready` (exists,
 * running), `resume` (exists, paused), or `create` (missing → auto-sized, role
 * "app", fronted by the cluster's edge). Pure except for the injected `load`, so
 * it unit-tests without AWS.
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
      role: "app",
      edgeNodeId: args.edgeNodeId,
      instanceType: sized.instanceType,
      capacity: sized.capacity,
    });
  }
  return actions;
}
