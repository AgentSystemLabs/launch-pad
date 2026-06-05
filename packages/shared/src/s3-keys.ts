/**
 * Pure S3 key/bucket derivation. The state bucket is account+region scoped so
 * the name is globally unique and deterministic (no config needed), and node
 * registries never bleed across regions.
 *
 * State is scoped by **cluster**. The `default` cluster uses the legacy
 * un-prefixed `nodes/<id>/` root so pre-cluster nodes need no migration; any
 * named cluster scopes its nodes under `clusters/<clusterId>/nodes/<id>/`.
 */

import { DEFAULT_CLUSTER } from "./constants";

export const NODES_PREFIX = "nodes/";
export const CLUSTERS_PREFIX = "clusters/";

export function stateBucketName(accountId: string, region: string): string {
  return `launch-pad-state-${accountId}-${region}`;
}

/** Root prefix for a cluster's per-node state. */
export function clusterNodesPrefix(clusterId: string): string {
  return clusterId === DEFAULT_CLUSTER
    ? NODES_PREFIX
    : `${CLUSTERS_PREFIX}${clusterId}/${NODES_PREFIX}`;
}

/** `cluster.json` for a named cluster (the `default` cluster has none). */
export function clusterConfigKey(clusterId: string): string {
  return `${CLUSTERS_PREFIX}${clusterId}/cluster.json`;
}

export function nodePrefix(clusterId: string, nodeId: string): string {
  return `${clusterNodesPrefix(clusterId)}${nodeId}/`;
}

export function nodeRegistryKey(clusterId: string, nodeId: string): string {
  return `${nodePrefix(clusterId, nodeId)}node.json`;
}

export function desiredKey(clusterId: string, nodeId: string): string {
  return `${nodePrefix(clusterId, nodeId)}desired.json`;
}

export function statusKey(clusterId: string, nodeId: string): string {
  return `${nodePrefix(clusterId, nodeId)}status.json`;
}

/** Advisory edge config (domains an edge fronts) at `<node prefix>/edge.json`. */
export function edgeConfigKey(clusterId: string, nodeId: string): string {
  return `${nodePrefix(clusterId, nodeId)}edge.json`;
}

/** Prefix where app agents publish routing shards for an edge: `<edge prefix>/upstream/`. */
export function edgeUpstreamPrefix(clusterId: string, edgeId: string): string {
  return `${nodePrefix(clusterId, edgeId)}upstream/`;
}

/** Routing shard an app agent writes for an edge: `<edge prefix>/upstream/<appNodeId>.json`. */
export function edgeUpstreamKey(clusterId: string, edgeId: string, appNodeId: string): string {
  return `${edgeUpstreamPrefix(clusterId, edgeId)}${appNodeId}.json`;
}

/** ECR repository name for a service: `<project>/<service>`. */
export function ecrRepositoryName(project: string, service: string): string {
  return `${project}/${service}`;
}

/** Frozen launch-pad.toml snapshot for post-deploy config locking (per footprint). */
export function configBaselineKey(clusterId: string, ownerProject: string): string {
  const prefix =
    clusterId === DEFAULT_CLUSTER ? "" : `${CLUSTERS_PREFIX}${clusterId}/`;
  return `${prefix}projects/${ownerProject}/config-baseline.json`;
}
