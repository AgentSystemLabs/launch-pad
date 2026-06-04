import { z } from "zod";

export const NodeStateSchema = z.enum([
  "provisioning",
  "ready",
  "stopped",
  "terminating",
  "terminated",
]);
export type NodeState = z.infer<typeof NodeStateSchema>;

/**
 * The registry entry stored at `nodes/<nodeId>/node.json` — the durable identity
 * and capacity of a node. EC2-specific fields are nullable so a node can be
 * registered (capacity known from its instance type) before / without a real
 * instance existing yet.
 */
export const NodeRegistryEntrySchema = z
  .object({
    nodeId: z.string().min(1),
    instanceId: z.string().nullable(),
    instanceType: z.string().min(1),
    region: z.string().min(1),
    availabilityZone: z.string().nullable(),
    /** Total CPU in vCPU shares (1024 = 1 vCPU). */
    totalCpu: z.number().int().nonnegative(),
    /** Total memory in MB. */
    totalMemory: z.number().int().nonnegative(),
    reservedCpu: z.number().int().nonnegative(),
    reservedMemory: z.number().int().nonnegative(),
    publicIp: z.string().nullable(),
    /** Elastic IP allocation id, if the node has a stable IP (survives stop/start). */
    eipAllocationId: z.string().nullable().default(null),
    securityGroupId: z.string().nullable(),
    iamInstanceProfile: z.string().nullable(),
    agentId: z.string(),
    agentVersion: z.string().nullable(),
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
