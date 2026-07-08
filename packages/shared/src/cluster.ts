import { z } from "zod";
import { AutoscalePolicySchema } from "./autoscale";
import { ClusterIdSchema } from "./config";

/**
 * `cluster.json` at `clusters/<clusterId>/cluster.json` — the authoritative
 * topology of a named cluster. A cluster is a set of nodes sharing one VPC,
 * one account/region, and (for web services) one edge router. The AWS account
 * + region a cluster lives in are resolved from local CLI config, not stored
 * here. The `default` cluster is implicit and has no cluster.json.
 */
export const ClusterConfigSchema = z
  .object({
    clusterId: ClusterIdSchema,
    /** Node id of the edge that fronts this cluster's web services, or null. */
    defaultEdge: z.string().min(1).nullable().default(null),
    region: z.string().min(1),
    createdAt: z.string(),
    createdBy: z.string(),
    /** Reactive autoscaling policy for the app pool, or null when not configured. */
    autoscale: AutoscalePolicySchema.nullable().default(null),
    /** SNS topic ARN for deploy notifications, or null when SNS is not enabled. */
    snsTopicArn: z.string().min(1).nullable().default(null),
  })
  .strict();

export type ClusterConfig = z.infer<typeof ClusterConfigSchema>;

export function parseClusterConfig(input: unknown): ClusterConfig {
  return ClusterConfigSchema.parse(input);
}
