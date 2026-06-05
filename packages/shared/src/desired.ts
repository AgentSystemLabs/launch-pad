import { z } from "zod";
import { PROTOCOL_VERSION } from "./constants";
import { HealthCheckSchema, RolloutSchema } from "./health";

/** Web ingress. Null on a service means it's a background worker (no Caddy). */
export const IngressSchema = z
  .object({
    domain: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    /** Node id of a remote edge that fronts this service, or null = co-located Caddy. */
    edge: z.string().min(1).nullable().default(null),
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
    ingress: IngressSchema.nullable(),
    healthCheck: HealthCheckSchema.nullable().default(null),
    rollout: RolloutSchema.default({}),
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

/** True when a service's domain is served by a remote edge node (not co-located). */
export function isRemoteEdge(c: ServiceConfig): boolean {
  return c.ingress != null && c.ingress.edge != null;
}

export function parseDesiredState(input: unknown): DesiredState {
  return DesiredStateSchema.parse(input);
}

export function emptyDesiredState(nodeId: string, now: string): DesiredState {
  return { version: PROTOCOL_VERSION, nodeId, updatedAt: now, services: [] };
}
