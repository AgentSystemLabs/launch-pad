import { z } from "zod";
import { DEFAULT_CLUSTER } from "./constants";

export const NodeStateSchema = z.enum([
  "provisioning",
  "ready",
  "stopped",
  "terminating",
  "terminated",
]);
export type NodeState = z.infer<typeof NodeStateSchema>;

/** What a node does: run app containers, be a Caddy edge router, or both. */
export const NodeRoleSchema = z.enum(["app", "edge", "both"]);
export type NodeRole = z.infer<typeof NodeRoleSchema>;

/** Which launch-pad agent runtime is installed on the node. */
export const NodeAgentTypeSchema = z.enum(["ts", "rust"]);
export type NodeAgentType = z.infer<typeof NodeAgentTypeSchema>;

/** `edge` / `both` need a stable public IP for DNS and HTTPS; `app` nodes are VPC-private only. */
export function nodeUsesElasticIp(role: NodeRole): boolean {
  return role !== "app";
}

/**
 * The registry entry stored at `nodes/<nodeId>/node.json` — the durable identity
 * and capacity of a node. EC2-specific fields are nullable so a node can be
 * registered (capacity known from its instance type) before / without a real
 * instance existing yet.
 */
export const NodeRegistryEntrySchema = z
  .object({
    nodeId: z.string().min(1),
    /** The cluster this node belongs to (defaults to "default" so pre-cluster node.json still parses). */
    clusterId: z.string().min(1).default(DEFAULT_CLUSTER),
    instanceId: z.string().nullable(),
    instanceType: z.string().min(1),
    region: z.string().min(1),
    availabilityZone: z.string().nullable(),
    /** Node role (defaults to "both" so pre-role node.json files still parse). */
    role: NodeRoleSchema.default("both"),
    /** VPC-internal IP an edge dials to reach this node's app containers. */
    privateIp: z.string().nullable().default(null),
    /** Total CPU in vCPU shares (1024 = 1 vCPU). */
    totalCpu: z.number().int().nonnegative(),
    /** Total memory in MB. */
    totalMemory: z.number().int().nonnegative(),
    reservedCpu: z.number().int().nonnegative(),
    reservedMemory: z.number().int().nonnegative(),
    publicIp: z.string().nullable(),
    /** Elastic IP allocation id for edge/both nodes (stable public IP across stop/start). */
    eipAllocationId: z.string().nullable().default(null),
    securityGroupId: z.string().nullable(),
    iamInstanceProfile: z.string().nullable(),
    agentId: z.string(),
    agentVersion: z.string().nullable(),
    /** Defaults old node.json files to the original TypeScript agent runtime. */
    agentType: NodeAgentTypeSchema.default("ts"),
    createdAt: z.string(),
    createdBy: z.string(),
    state: NodeStateSchema,
  })
  .strict();

export type NodeRegistryEntry = z.infer<typeof NodeRegistryEntrySchema>;

export function parseNodeRegistryEntry(input: unknown): NodeRegistryEntry {
  return NodeRegistryEntrySchema.parse(input);
}

export function agentIdForNode(nodeId: string): string {
  return `agent-${nodeId}`;
}

export function allocatableCpu(node: Pick<NodeRegistryEntry, "totalCpu" | "reservedCpu">): number {
  return node.totalCpu - node.reservedCpu;
}

export function allocatableMemory(
  node: Pick<NodeRegistryEntry, "totalMemory" | "reservedMemory">,
): number {
  return node.totalMemory - node.reservedMemory;
}
