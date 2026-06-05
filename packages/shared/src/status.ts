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

/** One replica of a service, so the edge can build per-replica upstreams. */
export const ReplicaStatusSchema = z
  .object({
    index: z.number().int().min(0),
    containerId: z.string().nullable(),
    /** Host port the replica is published on (null for workers). */
    hostPort: z.number().int().nullable(),
    state: ServiceStateSchema,
    image: z.string(),
    /** Last health-probe result (web replicas only). */
    healthy: z.boolean().default(false),
  })
  .strict();

export const ServiceStatusSchema = z
  .object({
    project: z.string(),
    service: z.string(),
    /** Rollup image: the converged image, or the in-progress one mid-rollout. */
    image: z.string(),
    /** Rollup state across replicas. */
    state: ServiceStateSchema,
    message: z.string().default(""),
    /** Rollup container id (first running replica), kept for back-compat. */
    containerId: z.string().nullable().default(null),
    replicas: z.array(ReplicaStatusSchema).default([]),
    desiredReplicas: z.number().int().min(0).default(0),
    runningReplicas: z.number().int().min(0).default(0),
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

/** What an edge node is currently routing (one entry per fronted domain). */
export const EdgeRouteStatusSchema = z
  .object({
    domain: z.string(),
    upstreams: z.number().int().min(0),
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
    /** Populated on edge nodes; [] elsewhere. */
    edgeRoutes: z.array(EdgeRouteStatusSchema).default([]),
  })
  .strict();

export type ReplicaStatus = z.infer<typeof ReplicaStatusSchema>;
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;
export type CaddyStatus = z.infer<typeof CaddyStatusSchema>;
export type EdgeRouteStatus = z.infer<typeof EdgeRouteStatusSchema>;
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
