import { z } from "zod";
import { HostStatsSchema } from "./stats";

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

/**
 * Rollup for a scheduled (`cron`) service. All-nullable: a freshly-deployed job
 * has no runs yet, and `nextRunAt` is null for an expression with no upcoming
 * fire. Optional on ServiceStatus so pre-cron documents (and non-cron services)
 * parse unchanged.
 */
export const CronRunStatusSchema = z
  .object({
    /** Scheduled fire time (UTC ISO) of the most recently STARTED run. */
    lastRunAt: z.string().nullable(),
    /** Exit code of the last COMPLETED run (null while running / before any run). */
    lastExitCode: z.number().int().nullable(),
    /** Next scheduled fire time (UTC ISO). */
    nextRunAt: z.string().nullable(),
  })
  .strict();

/** Per-logical-database result inside a database service's backup rollup. */
export const DatabaseBackupEntrySchema = z
  .object({
    name: z.string(),
    /** Completion time (UTC ISO) of the last successful dump, or null. */
    lastSuccessAt: z.string().nullable(),
    /** Size of the last uploaded dump in bytes, or null before any success. */
    sizeBytes: z.number().int().min(0).nullable(),
  })
  .strict();

/**
 * Backup rollup for a managed database service. Present only when `[database.backup]`
 * is configured. All-nullable so a freshly-deployed database (no run yet) parses, and
 * optional on ServiceStatus so non-database services are unchanged.
 */
export const DatabaseBackupStatusSchema = z
  .object({
    /** Scheduled fire time (UTC ISO) of the most recent backup run, or null. */
    lastRunAt: z.string().nullable(),
    /** Completion time (UTC ISO) of the last run where ALL databases dumped, or null. */
    lastSuccessAt: z.string().nullable(),
    /** Error from the last run (any database failed / upload failed), or null. */
    lastError: z.string().nullable(),
    /** Next scheduled fire time (UTC ISO), or null. */
    nextRunAt: z.string().nullable(),
    databases: z.array(DatabaseBackupEntrySchema).default([]),
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
    // The per-replica model was added after the original rollup-only status.json,
    // so these all carry back-compat defaults — an older document omits them and
    // must still parse. Do NOT remove the defaults.
    replicas: z.array(ReplicaStatusSchema).default([]),
    desiredReplicas: z.number().int().min(0).default(0),
    runningReplicas: z.number().int().min(0).default(0),
    /** Present only for scheduled (`cron`) services. */
    cron: CronRunStatusSchema.optional(),
    /** Present only for managed database services with backups enabled. */
    backup: DatabaseBackupStatusSchema.optional(),
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

/**
 * The node's most recent host-utilization sample, embedded in status.json so the
 * CLI (`autoscale run`) can read live CPU/memory without CloudWatch. Telemetry,
 * not convergence state — it is excluded from the agent's write-on-change
 * fingerprint and rides the liveness heartbeat. Optional so pre-sample documents
 * (and the first ticks before a sample exists) parse unchanged.
 */
export const HostSampleSchema = HostStatsSchema.extend({
  // Bounded strictly (unlike the CloudWatch stats line): this sample DRIVES autoscale
  // spend decisions, and per-node IAM means any single node can write its own status —
  // an out-of-range value must fail the parse (reader treats it as "no metrics"), not
  // drag the pool average over a scale-out threshold.
  cpuPercent: z.number().finite().min(0).max(100),
  memoryUsedMb: z.number().finite().min(0),
  memoryTotalMb: z.number().finite().min(0),
  /** ISO8601 time the sample was taken (staleness is judged by the reader). */
  sampledAt: z.string(),
}).strict();

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
    /** Latest host CPU/memory sample (see {@link HostSampleSchema}); absent until sampled. */
    host: HostSampleSchema.optional(),
  })
  .strict();

export type HostSample = z.infer<typeof HostSampleSchema>;
export type CronRunStatus = z.infer<typeof CronRunStatusSchema>;
export type DatabaseBackupEntry = z.infer<typeof DatabaseBackupEntrySchema>;
export type DatabaseBackupStatus = z.infer<typeof DatabaseBackupStatusSchema>;
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
