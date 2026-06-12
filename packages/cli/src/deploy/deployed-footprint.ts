import {
  type DeployedFootprint,
  type Ingress,
  type ServiceConfig,
  desiredKey,
  parseDesiredState,
} from "@agentsystemlabs/launch-pad-shared";
import type { S3Client } from "@aws-sdk/client-s3";
import { getJson, listNodeIds } from "../aws/s3-state";

/** What one node currently runs for a footprint, per its published desired.json. */
export interface NodeOccupancy {
  service: string;
  replicas: number;
  ingress: Ingress | null;
}

/** A footprint's published placement, viewed both per-service and per-node. */
export interface DeployedPlacementSnapshot {
  /** Per-service aggregate (replicas summed across nodes). */
  footprints: DeployedFootprint[];
  /** Every node currently hosting the footprint, sorted. */
  occupiedNodeIds: string[];
  /** Per-node service list — preserves per-node replica counts. */
  byNode: Map<string, NodeOccupancy[]>;
}

/** Aggregate a footprint's placement from per-node desired states. Pure — no S3. */
export function buildPlacementSnapshot(
  states: Array<{ nodeId: string; services: ServiceConfig[] }>,
  ownerProject: string,
): DeployedPlacementSnapshot {
  const byService = new Map<string, DeployedFootprint>();
  const byNode = new Map<string, NodeOccupancy[]>();

  for (const { nodeId, services } of states) {
    for (const s of services) {
      if (s.project !== ownerProject) continue;

      const occupancies = byNode.get(nodeId) ?? [];
      occupancies.push({ service: s.service, replicas: s.replicas, ingress: s.ingress });
      byNode.set(nodeId, occupancies);

      const existing = byService.get(s.service);
      if (!existing) {
        byService.set(s.service, {
          service: s.service,
          nodeIds: [nodeId],
          replicas: s.replicas,
          cpu: s.cpu,
          memory: s.memory,
          env: { ...s.env },
          secrets: s.secretRefs.map((r) => r.name),
          ingress: s.ingress,
          healthCheck: s.healthCheck,
          rollout: { ...s.rollout },
          volumes: s.volumes.map((v) => ({ ...v })),
          ...(s.cron !== undefined ? { cron: s.cron } : {}),
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

  return {
    footprints: [...byService.values()].sort((a, b) => a.service.localeCompare(b.service)),
    occupiedNodeIds: [...byNode.keys()].sort(),
    byNode,
  };
}

/** One node's published desired-state services (all projects), as the agent reconciles them. */
export interface NodeDesiredState {
  nodeId: string;
  services: ServiceConfig[];
}

/**
 * Read every node's desired.json in a cluster into raw per-node service lists (all
 * projects). Malformed/absent documents are skipped. Shared by `loadDeployedPlacement`
 * (footprint view) and `undeploy` (which needs the raw services to plan a removal).
 */
export async function loadNodeDesiredStates(
  s3: S3Client,
  bucket: string,
  clusterId: string,
): Promise<NodeDesiredState[]> {
  const states: NodeDesiredState[] = [];
  for (const nodeId of await listNodeIds(s3, bucket, clusterId)) {
    const obj = await getJson(s3, bucket, desiredKey(clusterId, nodeId));
    if (!obj) continue;
    try {
      states.push({ nodeId, services: parseDesiredState(obj.raw).services });
    } catch {
      /* skip a malformed desired.json — it can't host any footprint we'd act on */
    }
  }
  return states;
}

/** Load a footprint's published placement from every node's desired.json. */
export async function loadDeployedPlacement(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  ownerProject: string,
): Promise<DeployedPlacementSnapshot> {
  return buildPlacementSnapshot(await loadNodeDesiredStates(s3, bucket, clusterId), ownerProject);
}

/** Aggregate services already published for a footprint from every node's desired.json. */
export async function loadDeployedFootprints(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  ownerProject: string,
): Promise<DeployedFootprint[]> {
  return (await loadDeployedPlacement(s3, bucket, clusterId, ownerProject)).footprints;
}
