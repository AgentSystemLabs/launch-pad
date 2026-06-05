import type { DesiredState, UpstreamBackend, UpstreamShard } from "@agentsystemlabs/launch-pad-shared";
import { serviceKey } from "@agentsystemlabs/launch-pad-shared";
import type { ManagedReplica } from "./docker";

/** Build upstream shards grouped by edge id from desired state + live replicas. */
export function buildUpstreamShards(
  nodeId: string,
  privateIp: string,
  desired: DesiredState,
  live: Map<string, ManagedReplica[]>,
): Map<string, UpstreamShard> {
  const edges = new Set<string>();
  for (const c of desired.services) {
    if (c.ingress?.edge) edges.add(c.ingress.edge);
  }

  const shards = new Map<string, UpstreamShard>();
  const updatedAt = new Date().toISOString();

  for (const edgeId of edges) {
    shards.set(edgeId, { nodeId, privateIp, updatedAt, backends: [] });
  }

  for (const c of desired.services) {
    const edgeId = c.ingress?.edge;
    if (!edgeId) continue;

    const shard = shards.get(edgeId);
    if (!shard) continue;

    const reps = (live.get(serviceKey(c.project, c.service)) ?? []).filter(
      (r) => r.state === "running" && r.hostPort != null,
    );

    for (const r of reps) {
      const backend: UpstreamBackend = {
        domain: c.ingress!.domain,
        hostPort: r.hostPort!,
      };
      if (c.healthCheck?.path) backend.healthPath = c.healthCheck.path;
      shard.backends.push(backend);
    }
  }

  return shards;
}
