import { z } from "zod";

export const ServiceStateSchema = z.enum([
  "pending",
  "pulling",
  "starting",
  "running",
  "stopping",
  "error",
  "stopped",
]);
export type ServiceState = z.infer<typeof ServiceStateSchema>;

export const ServiceStatusSchema = z
  .object({
    project: z.string(),
    service: z.string(),
    /** Image the agent actually has running (compare to desired to detect drift). */
    image: z.string(),
    state: ServiceStateSchema,
    message: z.string().default(""),
    containerId: z.string().nullable().default(null),
    updatedAt: z.string(),
  })
  .strict();

export const CaddyStatusSchema = z
  .object({
    managed: z.boolean(),
    lastReloadAt: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export const NodeStatusSchema = z
  .object({
    nodeId: z.string(),
    agentId: z.string(),
    /** ISO heartbeat — written every loop, even when nothing changed. */
    lastSeen: z.string(),
    agentVersion: z.string(),
    services: z.array(ServiceStatusSchema),
    caddy: CaddyStatusSchema,
  })
  .strict();

export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;
export type CaddyStatus = z.infer<typeof CaddyStatusSchema>;
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export function parseNodeStatus(input: unknown): NodeStatus {
  return NodeStatusSchema.parse(input);
}

/** True when a heartbeat timestamp is older than the staleness threshold. */
export function isHeartbeatStale(lastSeen: string, nowMs: number, staleMs: number): boolean {
  const seen = Date.parse(lastSeen);
  if (Number.isNaN(seen)) return true;
  return nowMs - seen > staleMs;
}
