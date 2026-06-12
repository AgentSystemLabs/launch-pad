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

/** Root prefix under which every footprint's per-project state lives (for listings). */
export function projectsPrefix(clusterId: string): string {
  const prefix = clusterId === DEFAULT_CLUSTER ? "" : `${CLUSTERS_PREFIX}${clusterId}/`;
  return `${prefix}projects/`;
}

/** Root prefix for a footprint's per-project state (config baseline, deploy events). */
export function projectStatePrefix(clusterId: string, ownerProject: string): string {
  return `${projectsPrefix(clusterId)}${ownerProject}/`;
}

/**
 * Directory under `projects/` holding per-logical-project component indexes.
 * Leads with `_` so it can never collide with a real footprint owner
 * (LABEL_REGEX forbids underscores).
 */
export const PROJECT_INDEX_DIR = "_index";

/**
 * Component registry index for one logical project (see shared/src/project-registry.ts).
 * CLI-only state: maps a project to its deployed components and their owners.
 */
export function projectIndexKey(clusterId: string, project: string): string {
  return `${projectsPrefix(clusterId)}${PROJECT_INDEX_DIR}/${project}.json`;
}

/** Prefix listing every logical project's component index. */
export function projectIndexPrefix(clusterId: string): string {
  return `${projectsPrefix(clusterId)}${PROJECT_INDEX_DIR}/`;
}

/** Preview-environment marker written by `deploy --env` (see shared/src/preview.ts). */
export function previewMarkerKey(clusterId: string, ownerProject: string): string {
  return `${projectStatePrefix(clusterId, ownerProject)}preview.json`;
}

/** Frozen launch-pad.toml snapshot for post-deploy config locking (per footprint). */
export function configBaselineKey(clusterId: string, ownerProject: string): string {
  return `${projectStatePrefix(clusterId, ownerProject)}config-baseline.json`;
}

/** Prefix holding a footprint's append-only deploy-history events. */
export function deployEventsPrefix(clusterId: string, ownerProject: string): string {
  return `${projectStatePrefix(clusterId, ownerProject)}events/`;
}

/** Prefix holding a footprint's uploaded remote-build contexts (`deploy --remote-build`). */
export function remoteBuildContextPrefix(clusterId: string, ownerProject: string): string {
  return `${projectStatePrefix(clusterId, ownerProject)}builds/`;
}

/**
 * Key for one service's uploaded docker build context (a tar.gz CodeBuild downloads).
 * Lives under the cluster's prefix so `cluster destroy`'s sweep removes it.
 */
export function remoteBuildContextKey(
  clusterId: string,
  ownerProject: string,
  service: string,
  tag: string,
): string {
  return `${remoteBuildContextPrefix(clusterId, ownerProject)}${service}/${tag}.tar.gz`;
}

/**
 * Key for one deploy event. The object name leads with the ISO `at` timestamp so a plain
 * lexicographic S3 listing is chronological; the random `id` suffix avoids collisions when
 * two deploys land in the same millisecond.
 */
export function deployEventKey(clusterId: string, ownerProject: string, at: string, id: string): string {
  return `${deployEventsPrefix(clusterId, ownerProject)}${at}-${id}.json`;
}
