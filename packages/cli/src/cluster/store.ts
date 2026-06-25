import {
  type ClusterConfig,
  clusterConfigKey,
  parseClusterConfig,
} from "@agentsystemlabs/launch-pad-shared";
import type { AwsEnv } from "../aws/context";
import { getJson, putJson } from "../aws/s3-state";

/** Read a named cluster's `cluster.json`, or null when it doesn't exist. */
export async function getClusterConfig(aws: AwsEnv, clusterId: string): Promise<ClusterConfig | null> {
  const obj = await getJson(aws.s3, aws.bucket, clusterConfigKey(clusterId));
  if (!obj) return null;
  return parseClusterConfig(obj.raw);
}

export async function putClusterConfig(aws: AwsEnv, config: ClusterConfig): Promise<void> {
  await putJson(aws.s3, aws.bucket, clusterConfigKey(config.clusterId), config);
}

/** Read a cluster's config, creating a minimal one if it doesn't exist yet. */
export async function ensureClusterConfig(aws: AwsEnv, clusterId: string): Promise<ClusterConfig> {
  const existing = await getClusterConfig(aws, clusterId);
  if (existing) return existing;
  const config: ClusterConfig = {
    clusterId,
    defaultEdge: null,
    region: aws.region,
    createdAt: new Date().toISOString(),
    createdBy: aws.callerArn,
    autoscale: null,
    snsTopicArn: null,
  };
  await putClusterConfig(aws, config);
  return config;
}

/**
 * When a cluster has no edge yet, adopt this node as its default edge. Called
 * when an edge node is created in a cluster, so the first edge becomes the
 * cluster's router with no extra step.
 */
export async function adoptEdgeIfUnset(aws: AwsEnv, clusterId: string, edgeNodeId: string): Promise<void> {
  const cfg = await getClusterConfig(aws, clusterId);
  if (cfg && !cfg.defaultEdge) {
    await putClusterConfig(aws, { ...cfg, defaultEdge: edgeNodeId });
  }
}
