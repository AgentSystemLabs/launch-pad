import type { S3Client } from "@aws-sdk/client-s3";
import type { EdgeRouteStatus, NodeStatus } from "@agentsystemlabs/launch-pad-shared";
import { applyCaddy } from "./caddy";
import type { AgentConfig } from "./config";
import { buildShardRoutes, mergeRoutesByDomain } from "./routes";
import { listUpstreamShards, type ShardListCache } from "./s3";

/**
 * Edge reconcile: read upstream routing shards apps publish into this edge's prefix,
 * program Caddy to route each domain to healthy replicas over VPC private IPs, and
 * return the status to publish. The caller decides whether to actually write status
 * (write-on-change + liveness heartbeat); `applyCaddy` already no-ops when the config
 * is unchanged, and the optional shard cache skips redundant per-shard GETs.
 */
export async function edgeTick(
  config: AgentConfig,
  s3: S3Client,
  agentVersion: string,
  shardCache?: ShardListCache,
): Promise<NodeStatus> {
  const shards = await listUpstreamShards(
    s3,
    config.bucket,
    config.clusterId,
    config.nodeId,
    shardCache,
  );
  const routes = mergeRoutesByDomain(buildShardRoutes(shards));
  const edgeRoutes: EdgeRouteStatus[] = routes.map((r) => ({
    domain: r.domain,
    upstreams: r.upstreams.length,
  }));

  const caddy = await applyCaddy(routes);

  return {
    nodeId: config.nodeId,
    agentId: config.agentId,
    lastSeen: new Date().toISOString(),
    agentVersion,
    services: [],
    caddy,
    edgeRoutes,
  };
}
