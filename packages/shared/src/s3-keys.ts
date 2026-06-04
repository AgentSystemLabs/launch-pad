/**
 * Pure S3 key/bucket derivation. The state bucket is account+region scoped so
 * the name is globally unique and deterministic (no config needed), and node
 * registries never bleed across regions.
 */

export const NODES_PREFIX = "nodes/";

export function stateBucketName(accountId: string, region: string): string {
  return `launch-pad-state-${accountId}-${region}`;
}

export function nodePrefix(nodeId: string): string {
  return `${NODES_PREFIX}${nodeId}/`;
}

export function nodeRegistryKey(nodeId: string): string {
  return `${nodePrefix(nodeId)}node.json`;
}

export function desiredKey(nodeId: string): string {
  return `${nodePrefix(nodeId)}desired.json`;
}

export function statusKey(nodeId: string): string {
  return `${nodePrefix(nodeId)}status.json`;
}

/** ECR repository name for a service: `<project>/<service>`. */
export function ecrRepositoryName(project: string, service: string): string {
  return `${project}/${service}`;
}
