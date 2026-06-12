import { z } from "zod";
import { VolumeDeclSchema } from "./config";
import { PROTOCOL_VERSION } from "./constants";
import { HealthCheckSchema, RolloutSchema } from "./health";
import { SecretRefSchema } from "./secrets";

/**
 * Web ingress. Two states only:
 *
 *   ingress === null            → background worker (no domain, no Caddy at all)
 *   ingress.edge === "<nodeId>" → web service fronted by the cluster's dedicated edge node
 *
 * Caddy never co-locates with app containers, so `edge` is always a REMOTE node id.
 */
export const IngressSchema = z
  .object({
    domain: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    /** Node id of the dedicated edge that fronts this service. */
    edge: z.string().min(1),
  })
  .strict();

/**
 * One service inside a node's desired.json. Note it carries `project` ownership:
 * a node hosts services from many projects, and `(project, service)` is the key
 * that lets a deploy replace only its own footprint.
 */
export const ServiceConfigSchema = z
  .object({
    project: z.string().min(1),
    service: z.string().min(1),
    image: z.string().min(1),
    cpu: z.number().int().positive(),
    memory: z.number().int().positive(),
    /** How many replicas of this service run on THIS node. */
    replicas: z.number().int().min(1).default(1),
    env: z.record(z.string(), z.string()).default({}),
    /** SSM parameter refs resolved by the agent at container start (values never stored here). */
    secretRefs: z.array(SecretRefSchema).default([]),
    /** Bumped by `deploy --restart` to roll containers without a new image. */
    restartAt: z.string().optional(),
    /**
     * 5-field cron expression (UTC). Present → this is a SCHEDULED job: the agent
     * runs one short-lived container per fire instead of reconciling a long-running
     * replica set. Optional (not defaulted) so pre-cron documents parse unchanged.
     */
    cron: z.string().min(1).optional(),
    ingress: IngressSchema.nullable(),
    healthCheck: HealthCheckSchema.nullable().default(null),
    rollout: RolloutSchema.default({}),
    /**
     * Persistent named volumes the agent mounts into this service's container(s).
     * Defaulted so a desired.json written before volumes existed still parses. The
     * scheduler sticky-places a volume-bearing service (it never moves off the node
     * it first landed on), so the volume's data has a stable home on that node's disk.
     */
    volumes: z.array(VolumeDeclSchema).default([]),
  })
  .strict();

export const DesiredStateSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    nodeId: z.string().min(1),
    updatedAt: z.string(),
    services: z.array(ServiceConfigSchema),
  })
  .strict();

export type Ingress = z.infer<typeof IngressSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type DesiredState = z.infer<typeof DesiredStateSchema>;

/** Stable composite key for a service on a node. */
export function serviceKey(project: string, service: string): string {
  return `${project}/${service}`;
}

export function parseDesiredState(input: unknown): DesiredState {
  return DesiredStateSchema.parse(input);
}

/** Parse desired.json, or return an empty v2 document when legacy/corrupt. */
export function parseDesiredStateOrEmpty(nodeId: string, input: unknown, now: string): DesiredState {
  try {
    return parseDesiredState(input);
  } catch {
    return emptyDesiredState(nodeId, now);
  }
}

export function emptyDesiredState(nodeId: string, now: string): DesiredState {
  return { version: PROTOCOL_VERSION, nodeId, updatedAt: now, services: [] };
}
