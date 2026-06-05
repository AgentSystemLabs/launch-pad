import {
  type DeployedFootprint,
  desiredKey,
  parseDesiredState,
} from "@agentsystemlabs/launch-pad-shared";
import type { S3Client } from "@aws-sdk/client-s3";
import { getJson, listNodeIds } from "../aws/s3-state";

/** Aggregate services already published for a footprint from every node's desired.json. */
export async function loadDeployedFootprints(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  ownerProject: string,
): Promise<DeployedFootprint[]> {
  const byService = new Map<string, DeployedFootprint>();

  for (const nodeId of await listNodeIds(s3, bucket, clusterId)) {
    const obj = await getJson(s3, bucket, desiredKey(clusterId, nodeId));
    if (!obj) continue;

    const state = parseDesiredState(obj.raw);
    for (const s of state.services) {
      if (s.project !== ownerProject) continue;

      const existing = byService.get(s.service);
      if (!existing) {
        byService.set(s.service, {
          service: s.service,
          nodeIds: [nodeId],
          replicas: s.replicas,
          cpu: s.cpu,
          memory: s.memory,
          env: { ...s.env },
          ingress: s.ingress,
          healthCheck: s.healthCheck,
          rollout: { ...s.rollout },
        });
        continue;
      }

      existing.nodeIds.push(nodeId);
      existing.replicas += s.replicas;
    }
  }

  for (const fp of byService.values()) {
    fp.nodeIds.sort();
  }

  return [...byService.values()].sort((a, b) => a.service.localeCompare(b.service));
}
