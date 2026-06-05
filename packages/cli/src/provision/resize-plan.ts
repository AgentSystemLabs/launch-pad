import {
  type InstanceCapacity,
  type NodeRegistryEntry,
  nodeUsesElasticIp,
} from "@agentsystemlabs/launch-pad-shared";

/** Network as observed after the resized instance comes back up. */
export interface ResizeNetwork {
  publicIp: string | null;
  privateIp: string | null;
  availabilityZone: string | null;
}

export interface PlanResizedEntryArgs {
  /** The node's current registry entry. */
  node: NodeRegistryEntry;
  /** The instance type the node is being resized to. */
  instanceType: string;
  /** Capacity of the target instance type. */
  capacity: InstanceCapacity;
  /**
   * Whether the instance was running before the resize (and so was restarted
   * after). When false the node was paused — it stays stopped, just bigger/smaller.
   */
  restarted: boolean;
  /** The post-start network; only consulted when `restarted` is true. */
  network?: ResizeNetwork;
}

/**
 * Pure: compute the registry entry after a resize. The instance type and capacity
 * always change; everything else mirrors {@link resumeNode}'s IP handling:
 *
 * - **edge/both with an Elastic IP** keep their stable public IP across the stop/start.
 * - **edge/both without an Elastic IP** pick up a fresh ephemeral one on restart.
 * - **app** nodes stay VPC-private (no public IP); their private IP may change.
 * - a **paused** node (not restarted) stays `stopped` and drops any ephemeral public IP.
 */
export function planResizedEntry(args: PlanResizedEntryArgs): NodeRegistryEntry {
  const { node, instanceType, capacity, restarted, network } = args;
  const base = {
    ...node,
    instanceType,
    totalCpu: capacity.totalCpu,
    totalMemory: capacity.totalMemory,
  };

  if (!restarted) {
    // Left paused: a stopped instance has no ephemeral public IP, but an Elastic IP
    // survives the stop/start, so keep it (only when one is actually allocated).
    return {
      ...base,
      publicIp: node.eipAllocationId ? node.publicIp : null,
      state: "stopped",
    };
  }

  const net = network ?? { publicIp: null, privateIp: null, availabilityZone: null };
  const publicIp = nodeUsesElasticIp(node.role)
    ? node.eipAllocationId
      ? node.publicIp // stable Elastic IP — survives the resize
      : net.publicIp // no EIP — a new ephemeral public IP was assigned
    : null; // app node — VPC-private
  return {
    ...base,
    publicIp,
    privateIp: net.privateIp ?? node.privateIp,
    availabilityZone: net.availabilityZone,
    state: "ready",
  };
}
