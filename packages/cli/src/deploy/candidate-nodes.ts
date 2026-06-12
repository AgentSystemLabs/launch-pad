import {
  type CapacityServiceDemand,
  type NodeRegistryEntry,
  type ServiceConfig,
  allocatableCpu,
  allocatableMemory,
  desiredKey,
  nodeRegistryKey,
  nodeHostsContainers,
  parseDesiredState,
  parseDesiredStateOrEmpty,
  parseNodeRegistryEntry,
} from "@agentsystemlabs/launch-pad-shared";
import type { AwsEnv } from "../aws/context";
import { getJson, listNodeIds } from "../aws/s3-state";
import type { CandidateNode } from "./placement";

/** Per-service rollout-aware demand (cpu/memory already multiplied by replica count). */
export function demandsOf(services: ServiceConfig[]): CapacityServiceDemand[] {
  return services.map((s) => {
    const surge = Math.min(s.rollout.maxSurge, s.replicas);
    return {
      project: s.project,
      service: s.service,
      cpu: s.cpu * s.replicas,
      memory: s.memory * s.replicas,
      surgeCpu: s.cpu * surge,
      surgeMemory: s.memory * surge,
    };
  });
}

export interface CandidateNodes {
  /** Every cluster node by id (all roles) — used to look up an entry when publishing. */
  nodes: Map<string, NodeRegistryEntry>;
  /** app node ids in listNodeIds (S3-lexicographic) order — the schedulable pool. */
  clusterAppNodeIds: string[];
  /** The placement planner's view of the schedulable pool (same order). */
  candidateNodes: CandidateNode[];
}

/**
 * The cluster placement planner's view of every app node in the cluster, in
 * `listNodeIds` (S3-lexicographic) order. Shared by `deploy` and `rebalance` so a
 * placement one plans is feasible for the other. `ownerProject`'s own published services
 * are excluded from each node's committed demand because the caller's publish replaces them.
 *
 * `needsCapacitySnapshot` reads each node's desired.json for committed demand (required
 * for headroom-aware bin-packing — skip only when the caller knows the pool is empty).
 */
export async function buildCandidateNodes(
  aws: AwsEnv,
  ownerProject: string,
  opts: { needsCapacitySnapshot: boolean },
): Promise<CandidateNodes> {
  const nodes = new Map<string, NodeRegistryEntry>();
  const clusterAppNodeIds: string[] = [];
  const candidateNodes: CandidateNode[] = [];

  for (const id of await listNodeIds(aws.s3, aws.bucket, aws.clusterId)) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    if (!obj) continue;
    const entry = parseNodeRegistryEntry(obj.raw);
    nodes.set(id, entry);
    if (!nodeHostsContainers(entry.role)) continue;
    clusterAppNodeIds.push(id);

    let steadyCpu = 0;
    let steadyMemory = 0;
    let maxSurgeCpu = 0;
    let maxSurgeMemory = 0;
    if (opts.needsCapacitySnapshot) {
      const desired = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, id));
      const existing = desired
        ? parseDesiredStateOrEmpty(id, desired.raw, new Date().toISOString()).services
        : [];
      for (const d of demandsOf(existing.filter((s) => s.project !== ownerProject))) {
        steadyCpu += d.cpu;
        steadyMemory += d.memory;
        maxSurgeCpu = Math.max(maxSurgeCpu, d.surgeCpu ?? 0);
        maxSurgeMemory = Math.max(maxSurgeMemory, d.surgeMemory ?? 0);
      }
    }
    candidateNodes.push({
      nodeId: id,
      allocatableCpu: allocatableCpu(entry),
      allocatableMemory: allocatableMemory(entry),
      steadyCpu,
      steadyMemory,
      maxSurgeCpu,
      maxSurgeMemory,
    });
  }

  return { nodes, clusterAppNodeIds, candidateNodes };
}
